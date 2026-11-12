import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import type { InstanceHealthConfig } from "../config.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import {
  monitorInstancesOnce,
  pickDue,
  PROBE_EVERY_MS,
} from "../instances/monitor.js";

let h: Harness;
let appId: string;
let slug: string;

async function setup(health: Partial<InstanceHealthConfig> = {}) {
  h = await makeHarness(
    testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: {
          mode: "report",
          unhealthyWindowMs: 300_000,
          probesPerPass: 10,
          probesPerApp: 3,
          ...health,
        },
      },
    }),
  );
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
}
afterEach(async () => {
  // pickDue's tests make no harness.
  await h?.close();
  h = undefined as unknown as Harness;
});

const one = async () => (await listInstances(h.db, appId))[0];
const repo = () => `cr.vetra.io/acme/${slug}`;
const url = async (path: string) =>
  `https://${(await one()).host}.vetra.io${path}`;

type Pod = {
  digest: string;
  ready?: boolean;
  restarts?: number;
  waiting?: string | null;
  imageId?: boolean;
};
/** What observability would hold for the instance's tenant. */
async function setCluster(
  envId: string,
  pods: Pod[],
  argo: { drift?: boolean; message?: string } = {},
) {
  const tenantId = `t-${envId}`;
  h.tenants.set(envId, tenantId);
  await h.obsDb
    .deleteFrom("environment_pods")
    .where("tenantId", "=", tenantId)
    .execute();
  await h.obsDb
    .deleteFrom("environment_status")
    .where("tenantId", "=", tenantId)
    .execute();
  const at = h.clock.now.toISOString();
  await h.obsDb
    .insertInto("environment_status")
    .values({
      tenantId,
      argoSyncStatus: argo.drift ? "UNKNOWN" : "SYNCED",
      argoHealthStatus: "HEALTHY",
      argoLastSyncedAt: at,
      argoMessage: argo.message ?? null,
      configDriftDetected: argo.drift ? 1 : 0,
      tlsCertValid: null,
      tlsCertExpiresAt: null,
      domainResolves: null,
      updatedAt: at,
    })
    .execute();
  for (const [i, p] of pods.entries())
    await h.obsDb
      .insertInto("environment_pods")
      .values({
        id: `${tenantId}/app-${i}`,
        tenantId,
        name: `app-${i}`,
        service: "OTHER",
        component: "app",
        agent: null,
        phase: "RUNNING",
        ready: p.ready === false ? 0 : 1,
        restartCount: p.restarts ?? 0,
        image: `${repo()}:v@${p.digest}`,
        imageId: p.imageId === false ? null : `${repo()}@${p.digest}`,
        waitingReason: p.waiting ?? null,
        updatedAt: at,
      })
      .execute();
}

/** One instance on build a, its environment READY (the document's word only). */
async function created() {
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
  await reconcileInstancesOnce(h.deps);
  const envId = (await one()).environment_id!;
  h.envs.setStatus(envId, "READY");
  return envId;
}

const monitor = async (ms = PROBE_EVERY_MS + 1) => {
  h.advance(ms);
  return monitorInstancesOnce(h.deps);
};

describe("monitorInstancesOnce", () => {
  beforeEach(() => setup());

  it("records a healthy verdict, the observed digest from the pod, and leaves status and updated_at alone", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    const before = await one();
    expect(await monitor()).toBe(1);
    const row = await one();
    expect(row).toMatchObject({
      health: "healthy",
      health_check: null,
      health_reason: null,
      health_digest: digest("a"),
      health_restarts: 0,
      observed_digest: digest("a"),
      observed_digest_source: "pod",
      status: before.status,
      updated_at: before.updated_at,
    });
    expect(row.health_since).toBe(row.health_checked_at);
    expect(h.probed).toEqual([await url("/ready"), await url("/")]);
  });

  it("calls a crash loop unhealthy without probing the host", async () => {
    const envId = await created();
    await setCluster(envId, [
      {
        digest: digest("a"),
        ready: false,
        restarts: 3,
        waiting: "CrashLoopBackOff",
      },
    ]);
    await monitor();
    expect(await one()).toMatchObject({
      health: "unhealthy",
      health_check: "crash",
      health_restarts: 3,
    });
    expect(h.probed).toEqual([]);
  });

  it("catches a restart between two checks", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a"), restarts: 1 }]);
    await monitor();
    await setCluster(envId, [{ digest: digest("a"), restarts: 2 }]);
    await monitor();
    expect(await one()).toMatchObject({
      health: "unhealthy",
      health_check: "restarts",
    });
  });

  it("calls a render error unhealthy even while the old pods serve", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("0") }], {
      drift: true,
      message: "helm template failed",
    });
    await monitor();
    expect(await one()).toMatchObject({
      health: "unhealthy",
      health_check: "gitops",
    });
  });

  it("falls back to /health on images without /ready, and fails Connect errors", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    h.probes.set(await url("/ready"), {
      status: 404,
      contentType: null,
      error: null,
    });
    h.probes.set(await url("/"), {
      status: 500,
      contentType: "text/html",
      error: null,
    });
    await monitor();
    expect(h.probed).toEqual([
      await url("/ready"),
      await url("/health"),
      await url("/"),
    ]);
    expect(await one()).toMatchObject({
      health: "unhealthy",
      health_check: "connect",
      health_reason: "Connect answered 500",
    });
  });

  it("records a probe that throws as no answer, never failing the pass", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    h.deps.probe = async () => {
      throw new Error("socket hang up");
    };
    expect(await monitor()).toBe(1);
    expect(await one()).toMatchObject({
      health: "unhealthy",
      health_check: "switchboard",
      health_reason: "/ready did not answer (Error: socket hang up)",
    });
  });

  it("knows nothing without a tenant, and says so", async () => {
    await created();
    await monitor();
    expect(await one()).toMatchObject({
      health: "unknown",
      health_check: "data",
    });
  });

  it("does not check an instance again within 30 s", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    await monitor();
    expect(await monitor(1000)).toBe(0);
  });

  it("never reads or probes an environment a licence manages", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    await h.envs.manage(envId);
    await monitor();
    expect(h.probed).toEqual([]);
    expect((await one()).health).toBeNull();
  });

  it("does nothing when health is off", async () => {
    await h.close();
    await setup({ mode: "off" });
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    expect(await monitor()).toBe(0);
  });
});

describe("pickDue", () => {
  it("caps per pass and per app, oldest first", () => {
    const rows = ["a", "a", "a", "a", "b", "c"].map((app_id, i) => ({
      app_id,
      i,
    }));
    expect(pickDue(rows, 4, 3).map((r) => r.i)).toEqual([0, 1, 2, 4]);
    expect(pickDue(rows, 10, 1).map((r) => r.i)).toEqual([0, 4, 5]);
  });
});
