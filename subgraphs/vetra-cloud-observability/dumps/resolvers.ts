import type { Kysely } from "kysely";
import type { V1Job } from "@kubernetes/client-node";
import type { DumpsRepo } from "./repo.js";
import { requireOwner } from "./auth.js";
import { buildDumpJob } from "./job-spec.js";
import type { DatabaseDumps } from "../db/schema.js";

type Caller = { user?: { address: string } };

type EnvRow = { id: string; tenantId: string | null; owner: string | null };

async function loadEnv(
  envDb: Kysely<any>,
  tenantId: string,
): Promise<EnvRow | null> {
  const row = (await envDb
    .selectFrom("environments")
    .select(["id", "tenantId", "owner"])
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
  };
}

export type DumpResolverDeps = {
  repo: DumpsRepo;
  envDb: Kysely<any>;
  /** Creates the k8s Job. Returns the assigned name. */
  createJob: (namespace: string, body: V1Job) => Promise<string>;
  /** Deletes a Job. Used by cancelEnvironmentDump; idempotent on 404. */
  deleteJob: (namespace: string, name: string) => Promise<void>;
  /** Mints a presigned download URL for the given s3 key. */
  presign: (s3Key: string) => Promise<string>;
  image: string;
  bucket: string;
  s3Endpoint: string;
  /** Inlined into the Job's pod env. See buildDumpJob's note on threat model. */
  s3AccessKey: string;
  s3SecretKey: string;
};

export function createDumpResolvers(deps: DumpResolverDeps) {
  const {
    repo,
    envDb,
    createJob,
    deleteJob,
    presign,
    image,
    bucket,
    s3Endpoint,
    s3AccessKey,
    s3SecretKey,
  } = deps;

  return {
    Query: {
      environmentDumps: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ) => {
        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });

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
    },
    Mutation: {
      requestEnvironmentDump: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ) => {
        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });
        // requireOwner already throws ENV_NOT_FOUND when owner is null,
        // but loadEnv may return null (env doesn't exist at all). Be
        // explicit so we don't pass undefined to repo.create.
        if (!env) throw new Error("ENV_NOT_FOUND");

        const dump = await repo.create({
          documentId: env.id,
          tenantId: args.tenantId,
          requestedBy: ctx.user!.address,
          now: new Date(),
        });

        const job = buildDumpJob({
          dumpId: dump.id,
          tenantNs: args.tenantId,
          image,
          bucket,
          s3Endpoint,
          s3AccessKey,
          s3SecretKey,
        });
        try {
          const jobName = await createJob(args.tenantId, job);
          await repo.setJobName(dump.id, jobName || `pgdump-${dump.id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "createJob failed";
          await repo.markFailed(dump.id, msg, new Date());
          throw err;
        }

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
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });

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
    },
  };
}
