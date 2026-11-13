import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import { HOLDER, poolHarness } from "./pool-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listInstances } from "../instances/repo.js";
import { settingsRevisionOf } from "../instances/render.js";
import { monitorInstancesOnce, PROBE_EVERY_MS } from "../instances/monitor.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await poolHarness());
  h.deps.serviceOwner = "0x9999999999999999999999999999999999999999";
});
afterEach(async () => {
  await h.close();
});

const warm = async () =>
  (await listInstances(h.db, appId, "own")).find((r) => r.warm)!;

/** What observability holds for the tenant: one pod on the plan's digest, Argo synced. */
async function setCluster(
  envId: string,
  over: { restarts?: number; ready?: boolean } = {},
) {
  const tenantId = `t-${envId}`;
  h.tenants.set(envId, tenantId);
  const at = h.clock.now.toISOString();
  const state = (await h.envs.getState(envId))!;
  const repo = (await warm()).target_repository;
  await h.obsDb
    .insertInto("environment_status")
    .values({
      tenantId,
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
  await h.obsDb
    .insertInto("environment_pods")
    .values({
      id: `${tenantId}/app-0`,
      tenantId,
      name: "app-0",
      service: "OTHER",
      component: "app",
      agent: null,
      phase: "RUNNING",
      ready: over.ready === false ? 0 : 1,
      restartCount: over.restarts ?? 0,
      image: `${repo}:v@${digest("b")}`,
      imageId: `${repo}@${digest("b")}`,
      waitingReason: over.ready === false ? "CrashLoopBackOff" : null,
      settingsRevision: settingsRevisionOf(state),
      updatedAt: at,
    })
    .execute();
}

const monitor = async () => {
  h.advance(PROBE_EVERY_MS + 1);
  const at = h.clock.now.toISOString();
  await h.obsDb
    .updateTable("environment_pods")
    .set({ updatedAt: at })
    .execute();
  await h.obsDb
    .updateTable("environment_status")
    .set({ updatedAt: at })
    .execute();
  return monitorInstancesOnce(h.deps);
};

describe("warm rows are judged from the cluster only (W7)", () => {
  it("a warm row is healthy without probing; once claimed the host is probed", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await warm()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await setCluster(envId);
    await monitor();
    expect(await warm()).toMatchObject({ health: "healthy" });
    expect(h.probed).toEqual([]);

    await h.db
      .updateTable("instances")
      .set({ warm: false, holder_address: HOLDER, licence_root_id: "l1" })
      .where("id", "=", (await warm()).id)
      .execute();
    await monitor();
    const row = (await listInstances(h.db, appId, "own"))[0];
    expect(row.health).toBe("healthy");
    expect(h.probed).toEqual([
      `https://${row.host}.vetra.io/ready`,
      `https://${row.host}.vetra.io/`,
    ]);
  });

  it("a warm row whose pod crash-loops is unhealthy as for any instance", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await warm()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await setCluster(envId, { ready: false, restarts: 3 });
    await monitor();
    expect(await warm()).toMatchObject({
      health: "unhealthy",
      health_check: "crash",
    });
  });
});
