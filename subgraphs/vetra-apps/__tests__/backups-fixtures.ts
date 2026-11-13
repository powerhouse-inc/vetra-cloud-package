import type { V1Job } from "@kubernetes/client-node";
import type { InstanceStatus } from "../db/schema.js";
import type { VetraAppsConfig } from "../config.js";
import type { BackupK8s } from "../backups/k8s.js";
import {
  getInstance,
  insertInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { getApp } from "../repo.js";
import { archiveKey } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import {
  makeHarness,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { advanceBackups } from "../backups/service.js";
import { advanceRestores } from "../backups/restore.js";
import { activeRestoresOfApp } from "../backups/repo.js";

export const ARCHIVE_SHA = "e".repeat(64);
export const HOLDER = "0x1111111111111111111111111111111111111111";

type JobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: Array<{ type?: string; status?: string }>;
};

/** A cluster in memory: Jobs run until finish(); scaling is instant (pods = replicas). */
export function fakeBackupK8s() {
  const jobs = new Map<
    string,
    { ns: string; job: V1Job; status: JobStatus; logs: string }
  >();
  const deployments = new Map<string, Record<string, number>>();
  const images = new Map<string, string[]>();
  const pvcs = new Map<string, string>();
  const scaled: string[] = [];
  const k8s: BackupK8s = {
    async createJob(ns, job) {
      const name = job.metadata!.name!;
      if (jobs.has(name)) throw new Error(`Job ${name} exists`);
      jobs.set(name, { ns, job, status: { active: 1 }, logs: "" });
      return name;
    },
    async deleteJob(_ns, name) {
      jobs.delete(name);
    },
    async readJobStatus(_ns, name) {
      return jobs.get(name)?.status ?? null;
    },
    async readPodLogsForJob(_ns, name) {
      return jobs.get(name)?.logs ?? "";
    },
    async readDeploymentReplicas(ns) {
      return { ...(deployments.get(ns) ?? {}) };
    },
    async scaleDeployment(ns, name, replicas) {
      scaled.push(`${ns}/${name}=${replicas}`);
      deployments.set(ns, { ...(deployments.get(ns) ?? {}), [name]: replicas });
    },
    async countPods(ns) {
      return Object.values(deployments.get(ns) ?? {}).reduce(
        (a, b) => a + b,
        0,
      );
    },
    async deploymentsReady(ns, want) {
      return Object.entries(want).every(
        ([n, r]) => (deployments.get(ns)?.[n] ?? 0) >= r,
      );
    },
    async findDataPvc(ns) {
      return pvcs.get(ns) ?? null;
    },
    async deploymentImages(ns) {
      return images.get(ns) ?? [];
    },
  };
  return {
    k8s,
    jobs,
    deployments,
    images,
    pvcs,
    scaled,
    /** Ends every running Job whose name starts with `prefix`. */
    finish(prefix: string, ok = true, logs = "") {
      for (const [name, j] of jobs)
        if (name.startsWith(prefix) && j.status.active) {
          j.status = ok
            ? {
                succeeded: 1,
                conditions: [{ type: "Complete", status: "True" }],
              }
            : { failed: 1, conditions: [{ type: "Failed", status: "True" }] };
          j.logs = logs;
        }
    },
  };
}
export type FakeBackupK8s = ReturnType<typeof fakeBackupK8s>;

export async function backupHarness(over: Partial<VetraAppsConfig> = {}) {
  const h = await makeHarness(
    testConfig({
      plans: { enabled: true, stopAfterDays: 14 },
      backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 },
      ...over,
    }),
  );
  const fake = fakeBackupK8s();
  const deletedKeys: string[] = [];
  h.deps.backups = {
    k8s: fake.k8s,
    dumpJob: {
      image: "cr.vetra.io/x/pgdump-uploader:1.0.0",
      bucket: "dumps",
      s3Endpoint: "https://s3.test",
      s3AccessKey: "AK",
      s3SecretKey: "SK",
    },
    archiveImage: "cr.vetra.io/x/pgdump-uploader:1.1.0",
    deleteObject: async (key) => {
      deletedKeys.push(key);
    },
  };
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 1,
    kind: "release",
    digest: digest("a"),
  });
  await seedRelease(h, appId, {
    version: "1.5.0",
    run: 2,
    kind: "release",
    digest: digest("b"),
  });
  return {
    h,
    appId,
    app: async () => (await getApp(h.db, appId))!,
    fake,
    deletedKeys,
  };
}
export type BackupCtx = Awaited<ReturnType<typeof backupHarness>>;

const DIGEST = { "1.4.0": digest("a"), "1.5.0": digest("b") } as const;

/** A plan instance ready on `version`, in namespace t-<id>, with its app running and a data PVC. */
export async function planInstance(
  h: Harness,
  fake: FakeBackupK8s,
  appId: string,
  o: {
    id: string;
    kind?: "shared" | "own";
    version?: "1.4.0" | "1.5.0";
    status?: InstanceStatus;
  },
): Promise<InstanceRow> {
  const version = o.version ?? "1.4.0";
  const kind = o.kind ?? "own";
  const tenant = `t-${o.id}`;
  const env = `env-${o.id}`;
  h.tenants.set(env, tenant);
  fake.pvcs.set(tenant, `powerhouse-${tenant}-app-data`);
  fake.deployments.set(tenant, { [`powerhouse-${tenant}-app`]: 1 });
  fake.images.set(tenant, [
    `cr.vetra.io/acme/shop:${version}@${DIGEST[version]}`,
  ]);
  const at = "2026-10-01T00:00:00.000Z";
  return insertInstance(h.db, {
    id: o.id,
    app_id: appId,
    kind,
    name: o.id,
    branch: null,
    pr: null,
    host: `shop-${o.id}`,
    environment_id: env,
    target_version: version,
    target_digest: DIGEST[version],
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: version === "1.4.0" ? 1 : 2,
    running_version: version,
    running_digest: DIGEST[version],
    running_repository: "cr.vetra.io/acme/shop",
    status: o.status ?? "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: "p-1",
    holder_address: kind === "own" ? HOLDER : null,
    created_at: at,
    updated_at: at,
  });
}

/**
 * What observability's Job watcher records once the pending dumps and
 * archives finished (it does not run in tests), and the Jobs end.
 */
export async function finishBackupJobs(
  h: Harness,
  fake: FakeBackupK8s,
  outcome: "ok" | "dump_failed" | "archive_failed" = "ok",
): Promise<void> {
  const at = new Date().toISOString();
  for (const d of await h.obsDb
    .selectFrom("database_dumps")
    .selectAll()
    .where("status", "in", ["PENDING", "RUNNING"])
    .execute())
    await h.obsDb
      .updateTable("database_dumps")
      .set(
        outcome === "dump_failed"
          ? { status: "FAILED", errorMessage: "pg_dump: boom", completedAt: at }
          : {
              status: "READY",
              s3Key: `${d.tenantId}/${d.id}.dump`,
              sizeBytes: 100,
              completedAt: at,
            },
      )
      .where("id", "=", d.id)
      .execute();
  for (const a of await h.obsDb
    .selectFrom("data_archives")
    .selectAll()
    .where("status", "in", ["PENDING", "RUNNING"])
    .execute())
    await h.obsDb
      .updateTable("data_archives")
      .set(
        outcome === "archive_failed"
          ? { status: "FAILED", errorMessage: "tar: boom", completedAt: at }
          : {
              status: "READY",
              s3Key: archiveKey(a.tenantId, a.id),
              sizeBytes: 50,
              sha256: ARCHIVE_SHA,
              completedAt: at,
            },
      )
      .where("id", "=", a.id)
      .execute();
  fake.finish("pgdump-", outcome !== "dump_failed");
  fake.finish("dataarchive-", outcome !== "archive_failed");
}

/** Argo runs the instance's target image (the reconciler applied it). */
export async function deployTarget(
  h: Harness,
  fake: FakeBackupK8s,
  instanceId: string,
): Promise<void> {
  const i = (await getInstance(h.db, instanceId))!;
  fake.images.set(`t-${instanceId}`, [
    `${i.target_repository}:${i.target_version}@${i.target_digest}`,
  ]);
}

/** What reconcileApp runs before the rollouts: backups, then restores. */
export async function pass(ctx: BackupCtx): Promise<void> {
  await advanceBackups(ctx.h.deps, ctx.appId);
  await advanceRestores(ctx.h.deps, await ctx.app());
}

/**
 * Plays the cluster until no restore of the App is active: Jobs finish (the
 * one named by `fail` fails), and once a restore handed its instance back,
 * Argo runs the target image (unless deploy is false). At most 20 passes.
 */
export async function driveRestores(
  ctx: BackupCtx,
  o: {
    fail?: "pgdump-" | "pgrestore-" | "datarestore-";
    deploy?: boolean;
  } = {},
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await finishBackupJobs(
      ctx.h,
      ctx.fake,
      o.fail === "pgdump-" ? "dump_failed" : "ok",
    );
    ctx.fake.finish(
      "pgrestore-",
      o.fail !== "pgrestore-",
      o.fail === "pgrestore-" ? "psql: ERROR: boom" : "restore complete",
    );
    ctx.fake.finish(
      "datarestore-",
      o.fail !== "datarestore-",
      o.fail === "datarestore-"
        ? "archive checksum mismatch: 00"
        : "data restore complete",
    );
    if (o.deploy !== false)
      for (const r of await activeRestoresOfApp(ctx.h.db, ctx.appId))
        if (r.target_set) await deployTarget(ctx.h, ctx.fake, r.instance_id);
    await pass(ctx);
    if ((await activeRestoresOfApp(ctx.h.db, ctx.appId)).length === 0) return;
  }
  throw new Error("restores did not finish in 20 passes");
}
