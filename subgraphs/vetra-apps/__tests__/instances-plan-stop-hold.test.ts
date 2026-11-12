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
import { getHold, insertHold } from "../holds/repo.js";
import { listAudit } from "../audit/repo.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";
const TENANT = "own-tenant";
const DAY = 86_400_000;
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  h.deps.serviceOwner = SERVICE;
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

describe("plan instances stop by hold, never by sleep", () => {
  it("holds an ended licence's instance (no SLEEP), stopped once its app pod is gone", async () => {
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    expect(executedTypes()).not.toContain("SLEEP_ENVIRONMENT");
    expect(await getHold(h.db, envId)).toMatchObject({
      reason: LICENCE_ENDED,
      switchover_id: null,
      created_by: "vetra",
    });
    // re-rendered held: label unchanged, changes approved
    expect(executedTypes()).toEqual(["SET_LABEL", "APPROVE_CHANGES"]);
    expect(await status(envId)).toBe("CHANGES_APPROVED");
    expect(await planRow()).toMatchObject({ stopped_by_vetra: true });
    expect((await planRow()).status).not.toBe("stopped");

    // deployed, the app pod still there: waiting
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await planRow()).status).not.toBe("stopped");

    await cluster(false);
    await reconcileInstancesOnce(h.deps);
    expect(await planRow()).toMatchObject({
      status: "stopped",
      reason: LICENCE_ENDED,
      stopped_by_vetra: true,
    });
    expect(executedTypes()).not.toContain("SLEEP_ENVIRONMENT");
    expect(await status(envId)).not.toBe("STOPPED");
  });

  it("releases the hold on renewal (no WAKE), and the instance comes back", async () => {
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus(envId, "READY");
    await cluster(false);
    await reconcileInstancesOnce(h.deps);
    expect((await planRow()).status).toBe("stopped");

    h.envs.executed.length = 0;
    await renew();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    expect(executedTypes()).not.toContain("WAKE_ENVIRONMENT");
    expect(executedTypes()).toEqual(["SET_LABEL", "APPROVE_CHANGES"]);
    expect(await planRow()).toMatchObject({
      status: "updating",
      stopped_by_vetra: false,
    });
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await planRow()).status).toBe("ready");
  });

  it("re-renders a hold left without its render (a crash between the two)", async () => {
    const envId = await readyThenDue();
    await h.db
      .updateTable("instances")
      .set({ stopped_by_vetra: true })
      .where("environment_id", "=", envId)
      .execute();
    await insertHold(h.db, {
      environment_id: envId,
      reason: LICENCE_ENDED,
      switchover_id: null,
      created_by: "vetra",
      created_at: h.clock.now.toISOString(),
    });
    await reconcileInstancesOnce(h.deps);
    expect(executedTypes()).toEqual(["SET_LABEL", "APPROVE_CHANGES"]);
  });

  it("approves leftover pending changes as part of the hold", async () => {
    const envId = await readyThenDue();
    h.envs.setStatus(envId, "CHANGES_PENDING");
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
    expect(await status(envId)).toBe("CHANGES_APPROVED");
    expect(executedTypes()).not.toContain("SLEEP_ENVIRONMENT");
  });

  it("wakes an instance an earlier version slept, saying its database was re-created empty", async () => {
    const envId = await readyThenDue();
    await h.db
      .updateTable("instances")
      .set({ stopped_by_vetra: true, status: "stopped", reason: LICENCE_ENDED })
      .where("environment_id", "=", envId)
      .execute();
    h.envs.setStatus(envId, "STOPPED");
    await reconcileInstancesOnce(h.deps);
    expect(executedTypes()).toEqual([]); // stays stopped while the licence is ended
    expect(await getHold(h.db, envId)).toBeNull();

    await renew();
    await reconcileInstancesOnce(h.deps);
    expect(executedTypes()).toContain("WAKE_ENVIRONMENT");
    expect(await planRow()).toMatchObject({
      status: "updating",
      reason: STOPPED_BY_SLEEP,
      stopped_by_vetra: false,
    });
    const audit = await listAudit(h.db, appId, { limit: 50 });
    expect(
      audit.some(
        (a) =>
          a.action === "instance.status" &&
          (JSON.parse(a.detail) as { reason: string }).reason === STOPPED_BY_SLEEP,
      ),
    ).toBe(true);
  });

  it("leaves a switch-over's hold alone on renewal", async () => {
    const envId = await readyThenDue();
    await reconcileInstancesOnce(h.deps);
    await h.db
      .updateTable("environment_holds")
      .set({ switchover_id: "sw-1" })
      .where("environment_id", "=", envId)
      .execute();
    await renew();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toMatchObject({ switchover_id: "sw-1" });
  });

  it("neither holds nor releases an environment that is not a PLAN instance", async () => {
    const envId = await readyThenDue();
    const doc = h.envs.docs.get(envId)!;
    const app = doc.state.global.app!;
    const setApp = (a: VetraCloudEnvironmentState["app"]) =>
      h.envs.docs.set(envId, {
        ...h.envs.docs.get(envId)!,
        state: {
          ...doc.state,
          global: { ...h.envs.docs.get(envId)!.state.global, app: a },
        },
      });
    setApp({ ...app, role: "PRODUCTION" });
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    expect(executedTypes()).toEqual([]);
  });
});
