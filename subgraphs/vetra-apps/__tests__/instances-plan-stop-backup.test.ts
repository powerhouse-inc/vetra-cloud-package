import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan } from "../plans/repo.js";
import { LICENCE_ENDED, syncPlanInstances } from "../plans/sync.js";
import { getApp } from "../repo.js";
import {
  reconcileInstancesOnce,
  STOPPED_BY_SLEEP,
} from "../instances/reconciler.js";
import { getHold } from "../holds/repo.js";
import { fakeBackupK8s, finishBackupJobs } from "./backups-fixtures.js";
import { lastBackupOf } from "../backups/repo.js";
import { listAudit } from "../audit/repo.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";
const TENANT = "own-tenant";
const DAY = 86_400_000;
let h: Harness;
let appId: string;
let fake: ReturnType<typeof fakeBackupK8s>;

beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  h.deps.serviceOwner = SERVICE;
  h.deps.cfg = {
    ...h.deps.cfg,
    backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 },
  };
  fake = fakeBackupK8s();
  fake.pvcs.set(TENANT, `powerhouse-${TENANT}-app-data`);
  fake.deployments.set(TENANT, { [`powerhouse-${TENANT}-app`]: 1 });
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
    deleteObject: async () => {},
  };
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
  await insertPlan(h.db, {
    id: "plan-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
});
afterEach(async () => {
  await h.close();
});

const planRow = async () =>
  (await listInstances(h.db, appId)).find((r) => r.kind === "own")!;
const status = (id: string) => h.envs.getState(id).then((s) => s!.status);
const executedTypes = () => h.envs.executed.flatMap((e) => e.types);

/** What observability records for the tenant: fresh, with or without the app pod. */
async function cluster(appPod: boolean) {
  const at = h.clock.now.toISOString();
  await h.obsDb.deleteFrom("environment_pods").where("tenantId", "=", TENANT).execute();
  await h.obsDb.deleteFrom("environment_status").where("tenantId", "=", TENANT).execute();
  await h.obsDb
    .insertInto("environment_status")
    .values({
      tenantId: TENANT,
      argoSyncStatus: "SYNCED",
      argoHealthStatus: "HEALTHY",
      argoLastSyncedAt: at,
      argoMessage: null,
      configDriftDetected: 0,
      tlsCertValid: null,
      tlsCertExpiresAt: null,
      domainResolves: null,
      updatedAt: at,
    })
    .execute();
  const pods = [{ name: "pg-1", component: "database" }];
  if (appPod) pods.push({ name: "app-1", component: "app" });
  for (const p of pods)
    await h.obsDb
      .insertInto("environment_pods")
      .values({
        id: `${TENANT}/${p.name}`,
        tenantId: TENANT,
        name: p.name,
        service: "OTHER",
        component: p.component,
        agent: null,
        phase: "Running",
        ready: 1,
        restartCount: 0,
        updatedAt: at,
      })
      .execute();
}

/** A READY own instance of l1, its licence ended past the stop window. */
async function readyThenDue(): Promise<string> {
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await reconcileInstancesOnce(h.deps);
  const envId = (await planRow()).environment_id!;
  h.tenants.set(envId, TENANT);
  h.envs.setStatus(envId, "READY");
  await reconcileInstancesOnce(h.deps);
  await h.deps
    .licensingDb!.updateTable("license_lifecycle")
    .set({ status: "EXPIRED" })
    .where("license_id", "=", "l1")
    .execute();
  await syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
  h.advance(15 * DAY);
  await cluster(true);
  h.envs.executed.length = 0;
  return envId;
}
const renew = () =>
  seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1b", root: "l1" });

describe("a final backup before a plan instance is held (decision B9)", () => {
  it("backs up first, holds once the backup is ready, never holds while it runs", async () => {
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    const inst = await planRow();
    const b = (await lastBackupOf(h.db, inst.id, "pre_stop"))!;
    expect(b).toMatchObject({ status: "pending", reason: "pre_stop" });
    expect(inst.reason).toMatch(/final backup/);
    // Still running: no second backup, no hold.
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    await finishBackupJobs(h, fake);
    await reconcileInstancesOnce(h.deps); // advanceBackups settles it; the stop goes on
    expect(await getHold(h.db, envId)).toMatchObject({ reason: LICENCE_ENDED });
    expect((await lastBackupOf(h.db, inst.id, "pre_stop"))!.id).toBe(b.id);
  });

  it("a failed final backup does not keep the instance running: the hold keeps its data", async () => {
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    await finishBackupJobs(h, fake, "dump_failed");
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
  });

  it("a backup that cannot be taken (no /data volume) does not block the stop", async () => {
    const envId = await readyThenDue();
    fake.pvcs.clear();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
  });

  it("with backups off it holds at once, as before", async () => {
    h.deps.cfg = {
      ...h.deps.cfg,
      backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 },
    };
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
    expect(await lastBackupOf(h.db, (await planRow()).id, "pre_stop")).toBeNull();
  });
});
