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
import { DEGRADED_AFTER_MS, HEALTH_STABLE_MS } from "../instances/status.js";
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

/** Observability refreshes its rows every minute; until now they are as fresh as the clock. */
async function refreshCluster() {
  const at = h.clock.now.toISOString();
  await h.obsDb
    .updateTable("environment_pods")
    .set({ updatedAt: at })
    .execute();
  await h.obsDb
    .updateTable("environment_status")
    .set({ updatedAt: at })
    .execute();
}

const monitor = async (ms = PROBE_EVERY_MS + 1) => {
  h.advance(ms);
  await refreshCluster();
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

  it("knows nothing from cluster rows older than 5 minutes", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    await monitor();
    expect((await one()).health).toBe("healthy");
    h.advance(5 * 60_000 + 1);
    await monitorInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      health: "unknown",
      health_check: "data",
      health_reason: "the cluster data is older than 5 minutes",
    });
    expect(h.probed.length).toBeGreaterThan(0);
    const probes = h.probed.length;
    await monitor();
    expect((await one()).health).toBe("healthy");
    expect(h.probed.length).toBeGreaterThan(probes);
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
    // Stamped as checked (no data) so it never starves the caps.
    expect(await one()).toMatchObject({
      health: "unknown",
      health_check: "data",
      health_digest: null,
      observed_digest: null,
    });
  });

  it("never lets skipped instances starve an app's cap", async () => {
    await h.db
      .updateTable("apps")
      .set({ release_branches: '["b1","b2","b3"]' })
      .where("id", "=", appId)
      .execute();
    for (const [i, branch] of ["main", "b1", "b2", "b3"].entries())
      await seedRelease(h, appId, {
        version: `1.5.0-${branch}.1`,
        run: 100 + i,
        branch,
      });
    await reconcileInstancesOnce(h.deps);
    const rows = (await listInstances(h.db, appId)).sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows.slice(0, 3)) await h.envs.manage(r.environment_id!);
    const normal = rows[3];
    h.envs.setStatus(normal.environment_id!, "READY");
    await setCluster(normal.environment_id!, [{ digest: digest("a") }]);
    await monitor();
    await monitor();
    const after = (await listInstances(h.db, appId)).find(
      (r) => r.id === normal.id,
    )!;
    expect(after.health).toBe("healthy");
  });

  it("stamps an instance whose check throws, so the pass moves on", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    h.deps.envTenant = async () => {
      throw new Error("read model down");
    };
    expect(await monitor()).toBe(0);
    expect(await one()).toMatchObject({
      health: "unknown",
      health_check: "data",
    });
    expect((await one()).health_reason).toMatch(/read model down/);
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

const WINDOW = 300_000;
/** One health check then one reconciler pass, ms later. */
const pass = async (ms = PROBE_EVERY_MS + 1) => {
  await monitor(ms);
  await reconcileInstancesOnce(h.deps);
};
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!
    .version;

/** Instance ready on build a by health (enforce). */
async function readyHealthy() {
  const envId = await created();
  await setCluster(envId, [{ digest: digest("a") }]);
  await pass();
  expect((await one()).status).toBe("updating");
  await pass(HEALTH_STABLE_MS);
  expect(await one()).toMatchObject({
    status: "ready",
    running_digest: digest("a"),
  });
  return envId;
}
async function updateToB() {
  await seedRelease(h, appId, {
    version: "1.5.0-main.2",
    run: 200,
    digest: digest("b"),
  });
  await reconcileInstancesOnce(h.deps);
  expect((await one()).status).toBe("updating");
}

describe("enforce: status follows health", () => {
  beforeEach(() => setup({ mode: "enforce", unhealthyWindowMs: WINDOW }));

  it("never calls a crash-looping first deploy ready, and fails it after the window", async () => {
    const envId = await created();
    await setCluster(envId, [
      {
        digest: digest("a"),
        ready: false,
        restarts: 3,
        waiting: "CrashLoopBackOff",
      },
    ]);
    await pass();
    expect((await one()).status).toBe("updating");
    await pass(WINDOW);
    expect(await one()).toMatchObject({
      status: "failed",
      reason:
        "unhealthy (crash: the container does not start (CrashLoopBackOff))",
    });
  });

  it("fails a crashing update and goes back to the last healthy digest", async () => {
    const envId = await readyHealthy();
    await updateToB();
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.2@${digest("b")}`);
    await setCluster(envId, [
      { digest: digest("a") },
      {
        digest: digest("b"),
        ready: false,
        restarts: 2,
        waiting: "CrashLoopBackOff",
      },
    ]);
    await pass();
    await pass(WINDOW);
    expect(await one()).toMatchObject({
      status: "failed",
      failed_digest: digest("b"),
      running_digest: digest("a"),
    });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("fails an update Argo cannot render and goes back", async () => {
    const envId = await readyHealthy();
    await updateToB();
    await setCluster(envId, [{ digest: digest("a") }], {
      drift: true,
      message: "helm template failed",
    });
    await pass();
    await pass(WINDOW);
    expect(await one()).toMatchObject({
      status: "failed",
      reason:
        "unhealthy (gitops: Argo CD cannot apply the environment (helm template failed))",
    });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("degrades a ready instance that stops serving, without touching it, then recovers", async () => {
    const envId = await readyHealthy();
    const writes = h.envs.executed.length;
    await setCluster(envId, [{ digest: digest("a"), ready: false }]);
    await pass();
    expect((await one()).status).toBe("ready");
    await pass(DEGRADED_AFTER_MS);
    expect(await one()).toMatchObject({
      status: "degraded",
      reason: "pod: the pod is starting",
      health: "unknown",
    });
    await setCluster(envId, [{ digest: digest("a") }]);
    await pass();
    expect((await one()).status).toBe("degraded");
    await pass(HEALTH_STABLE_MS);
    expect(await one()).toMatchObject({ status: "ready", reason: null });
    expect(h.envs.executed.length).toBe(writes);
  });

  it("never fails an update on one unhealthy check after minutes of unknown", async () => {
    const envId = await created();
    for (let i = 0; i < 12; i++) await pass(); // 6 minutes, no cluster data
    expect(await one()).toMatchObject({
      status: "updating",
      health: "unknown",
    });
    await setCluster(envId, [
      { digest: digest("a"), ready: false, waiting: "CrashLoopBackOff" },
    ]);
    await pass();
    const row = await one();
    expect(row).toMatchObject({ status: "updating", health: "unhealthy" });
    expect(row.health_since).toBe(row.health_checked_at);
    await pass();
    expect((await one()).status).toBe("failed");
  });

  it("restarts the health clock when the environment leaves STOPPED", async () => {
    const envId = await readyHealthy();
    h.envs.setStatus(envId, "STOPPED");
    await setCluster(envId, [{ digest: digest("a"), ready: false }]);
    await pass();
    await pass(DEGRADED_AFTER_MS * 3);
    h.envs.setStatus(envId, "DEPLOYING");
    await pass();
    const row = await one();
    expect(row).toMatchObject({ health: "unknown", health_check: "pod" });
    expect(row.health_since).toBe(row.health_checked_at);
    expect(row.status).not.toBe("degraded");
  });

  it("never reverts an update that times out without fresh cluster data", async () => {
    const envId = await readyHealthy();
    await updateToB();
    await setCluster(envId, [{ digest: digest("a") }]);
    // Observability stops: its rows age, nothing new arrives.
    for (let i = 0; i < 45; i++) {
      h.advance(PROBE_EVERY_MS + 1);
      await monitorInstancesOnce(h.deps);
      await reconcileInstancesOnce(h.deps);
    }
    expect(await one()).toMatchObject({
      status: "updating",
      reason:
        "not healthy after 20 minutes, but there is no fresh health data; waiting for it",
      failed_digest: null,
    });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.2@${digest("b")}`);
  });

  it("does not stay stopped after a start when health has no data", async () => {
    const envId = await readyHealthy();
    h.envs.setStatus(envId, "STOPPED");
    await pass();
    expect((await one()).status).toBe("stopped");
    h.tenants.delete(envId);
    h.envs.setStatus(envId, "READY");
    await pass();
    expect(await one()).toMatchObject({
      status: "ready",
      health_check: "data",
    });
  });

  it("shows an owner stop as stopped, and the start as degraded until healthy", async () => {
    const envId = await readyHealthy();
    h.envs.setStatus(envId, "STOPPED");
    await pass();
    expect((await one()).status).toBe("stopped");
    h.envs.setStatus(envId, "DEPLOYING");
    await setCluster(envId, [{ digest: digest("a"), ready: false }]);
    await pass();
    await pass(DEGRADED_AFTER_MS);
    expect((await one()).status).toBe("degraded");
    await setCluster(envId, [{ digest: digest("a") }]);
    await pass();
    await pass(HEALTH_STABLE_MS);
    expect((await one()).status).toBe("ready");
  });
});

describe("report: health is shown, status keeps the document's rule", () => {
  beforeEach(() => setup({ mode: "report" }));

  it("calls a crash loop ready (as before) but records it unhealthy", async () => {
    const envId = await created();
    await setCluster(envId, [
      {
        digest: digest("a"),
        ready: false,
        restarts: 3,
        waiting: "CrashLoopBackOff",
      },
    ]);
    await pass();
    expect(await one()).toMatchObject({
      status: "ready",
      health: "unhealthy",
      health_check: "crash",
    });
  });
});
