import type { Kysely } from "kysely";
import type { V1Job } from "@kubernetes/client-node";
import type { DumpsRepo } from "./repo.js";
import { authorizeDump } from "./auth.js";
import { OWNER_ONLY_ACCESS, type EnvAccess } from "../env-access.js";
import { applyRetention, RETENTION } from "./retention.js";
import { createDumpAndJob } from "./service.js";
import type { DatabaseDumps, DatabaseRestores } from "../db/schema.js";
import type { RestoresRepo } from "./restore-repo.js";

type Caller = { user?: { address: string } };

type EnvRow = {
  id: string;
  tenantId: string | null;
  owner: string | null;
  ownerOrgId: string | null;
  appId: string | null;
  status: string | null;
};

async function loadEnv(
  envDb: Kysely<any>,
  tenantId: string,
): Promise<EnvRow | null> {
  const row = (await envDb
    .selectFrom("environments")
    .select(["id", "tenantId", "owner", "ownerOrgId", "appId", "status"])
    .where("tenantId", "=", tenantId)
    .executeTakeFirst()) as EnvRow | undefined;
  return row ?? null;
}

function toGraphql(row: DatabaseDumps, presignedUrl: string | null) {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    errorMessage: row.errorMessage,
    downloadUrl: presignedUrl,
    source: row.source,
  };
}

function restoreToGraphql(row: DatabaseRestores) {
  return {
    id: row.id,
    dumpId: row.dumpId,
    safetyDumpId: row.safetyDumpId,
    status: row.status,
    errorMessage: row.errorMessage,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  };
}

export type DumpResolverDeps = {
  repo: DumpsRepo;
  restores: RestoresRepo;
  envDb: Kysely<any>;
  /** Creates the k8s Job. Returns the assigned name. */
  createJob: (namespace: string, body: V1Job) => Promise<string>;
  /** Deletes a Job. Used by cancelEnvironmentDump; idempotent on 404. */
  deleteJob: (namespace: string, name: string) => Promise<void>;
  /** Mints a presigned download URL for the given s3 key. */
  presign: (s3Key: string) => Promise<string>;
  /** Deletes a dump file; used by retention. */
  deleteObject: (s3Key: string) => Promise<void>;
  image: string;
  bucket: string;
  s3Endpoint: string;
  /** Inlined into the Job's pod env. See buildDumpJob's note on threat model. */
  s3AccessKey: string;
  s3SecretKey: string;
  /** Org-aware access checks; default: owner only (org envs refused). */
  access?: EnvAccess;
};

export function createDumpResolvers(deps: DumpResolverDeps) {
  const {
    repo,
    restores,
    envDb,
    createJob,
    deleteJob,
    presign,
    deleteObject,
    image,
    bucket,
    s3Endpoint,
    s3AccessKey,
    s3SecretKey,
  } = deps;
  const access = deps.access ?? OWNER_ONLY_ACCESS;

  return {
    Query: {
      environmentDumps: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ) => {
        const env = await loadEnv(envDb, args.tenantId);
        await authorizeDump(access, { caller: ctx.user?.address ?? null, env });

        const rows = await repo.listByTenant(args.tenantId);
        const now = Date.now();
        return Promise.all(
          rows.map(async (row) => {
            const expired = new Date(row.expiresAt).getTime() < now;
            if (row.status !== "READY" || expired || !row.s3Key) {
              return toGraphql(row, null);
            }
            const url = await presign(row.s3Key).catch(() => null);
            return toGraphql(row, url);
          }),
        );
      },
      environmentRestores: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ) => {
        const env = await loadEnv(envDb, args.tenantId);
        await authorizeDump(access, { caller: ctx.user?.address ?? null, env });
        return (await restores.listByTenant(args.tenantId)).map(restoreToGraphql);
      },
    },
    Mutation: {
      requestEnvironmentDump: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ) => {
        const env = await loadEnv(envDb, args.tenantId);
        await authorizeDump(access, { caller: ctx.user?.address ?? null, env });
        // authorizeDump already throws ENV_NOT_FOUND for a missing env;
        // the explicit check narrows the type for repo.create.
        if (!env) throw new Error("ENV_NOT_FOUND");
        if (await restores.activeForTenant(args.tenantId)) {
          throw new Error("RESTORE_IN_PROGRESS");
        }

        const dump = await createDumpAndJob(
          { repo, createJob, image, bucket, s3Endpoint, s3AccessKey, s3SecretKey },
          {
            documentId: env.id,
            tenantId: args.tenantId,
            requestedBy: ctx.user!.address,
            source: "MANUAL",
          },
        );
        await applyRetention(repo, deleteObject, args.tenantId, "MANUAL", RETENTION.MANUAL);

        return toGraphql(dump, null);
      },
      cancelEnvironmentDump: async (
        _p: unknown,
        args: { dumpId: string },
        ctx: Caller,
      ) => {
        const row = await repo.getById(args.dumpId);
        if (!row) throw new Error("DUMP_NOT_FOUND");

        const env = await loadEnv(envDb, row.tenantId);
        await authorizeDump(access, { caller: ctx.user?.address ?? null, env });

        // Terminal states: nothing to cancel. Return the row as-is so
        // the UI can refresh without special-casing the response.
        if (row.status === "READY" || row.status === "FAILED") {
          return toGraphql(row, null);
        }

        // Best-effort Job deletion. If jobName is null the row was
        // created but the Job never registered — nothing to delete,
        // just mark FAILED. If the Job is already gone, deleteJob
        // swallows 404. Other errors propagate so the caller sees
        // them (and the row stays in its current state for retry).
        if (row.jobName) {
          await deleteJob(row.tenantId, row.jobName);
        }
        await repo.markFailed(row.id, "Cancelled by user", new Date());

        const updated = await repo.getById(row.id);
        return toGraphql(updated ?? row, null);
      },
      /**
       * Starts a tracked restore of a READY dump into its own environment:
       * a PRE_RESTORE safety dump first, then the restore advancer
       * (`restore.ts`) stops the Switchboard, runs the restore Job and
       * starts it again. No target parameter, so a dump can only ever be
       * restored into the environment it was taken from.
       */
      restoreEnvironmentDump: async (
        _p: unknown,
        args: { dumpId: string },
        ctx: Caller,
      ) => {
        const dump = await repo.getById(args.dumpId);
        if (!dump) throw new Error("DUMP_NOT_FOUND");
        const env = await loadEnv(envDb, dump.tenantId);
        await authorizeDump(access, { caller: ctx.user?.address ?? null, env });
        if (!env) throw new Error("ENV_NOT_FOUND");
        if (env.status !== "READY") throw new Error("ENV_NOT_READY");
        if (dump.status !== "READY" || !dump.s3Key) throw new Error("DUMP_NOT_READY");
        if (new Date(dump.expiresAt).getTime() < Date.now()) throw new Error("DUMP_EXPIRED");
        if (await restores.activeForTenant(dump.tenantId)) {
          throw new Error("RESTORE_IN_PROGRESS");
        }

        // Throws DUMP_IN_PROGRESS when any dump is in flight for the tenant,
        // which also serialises double-clicked restores.
        const safety = await createDumpAndJob(
          { repo, createJob, image, bucket, s3Endpoint, s3AccessKey, s3SecretKey },
          {
            documentId: env.id,
            tenantId: dump.tenantId,
            requestedBy: ctx.user!.address,
            source: "PRE_RESTORE",
          },
        );
        const restore = await restores.create({
          documentId: env.id,
          tenantId: dump.tenantId,
          dumpId: dump.id,
          safetyDumpId: safety.id,
          requestedBy: ctx.user!.address,
          now: new Date(),
        });
        return restoreToGraphql(restore);
      },
    },
  };
}
