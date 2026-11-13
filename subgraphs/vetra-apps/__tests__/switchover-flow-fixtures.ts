import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import {
  approveChanges,
  enableService,
  initialize,
  setFusionConfig,
  setLabel,
  setManagedBy,
  setOwner,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import { freezeAppReleases } from "../../vetra-licensing/release-service.js";
import { createRolloutStore } from "../../vetra-licensing/rollout-db.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { insertPlan } from "../plans/repo.js";
import type { SwitchoverPorts } from "../switchover/ports.js";
import { insertSwitchover, type SwitchoverRow } from "../switchover/repo.js";
import { advanceSwitchoversOnce } from "../switchover/runner.js";
import { KEY_FILES } from "../switchover/keys.js";
import { COUNTS, fakeCounts, fakeSwitchoverBackups } from "./fakes/backups.js";
import {
  makeHarness,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import {
  seedLicence,
  seedLicensedEnvironment,
  seedRelease,
} from "./instances-fixtures.js";
import { switchoverRow } from "./switchover-fixtures.js";

export const HOLDER = "0x1111111111111111111111111111111111111111";
export const OLD_HOST = "fair-ibis-huk51fts";
export const OLD_TENANT = "fair-ibis-huk51fts-huk51fts";
export const MASTER = "7".repeat(64);
export const ATTACH = "8".repeat(64);
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const SWITCHOVER_CFG = {
  enabled: true,
  leadHours: 24,
  holdDays: 30,
  confirmHours: 72,
  restoreJobs: 4,
};

/** A whole Sektar-shaped world: the old licensed environment, its plan, release, freeze, and a switch-over of it. */
export async function flow(
  o: {
    mode?: "real" | "dry_run";
    frozen?: boolean;
    state?: SwitchoverRow["state"];
  } = {},
) {
  const h: Harness = await makeHarness(
    testConfig({
      plans: { enabled: true, stopAfterDays: 14 },
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { mode: "enforce", unhealthyWindowMs: 300_000 },
      },
      switchover: SWITCHOVER_CFG,
    } as never),
  );
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  const release = await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
  });
  await seedLicence(h, {
    appId,
    kind: "sektar-cloud",
    holder: HOLDER,
    licenseId: "l1",
  });
  // The old licensed environment: READY, owned by the holder, ADMINS + PH_HOST only.
  const oldEnv = await h.envs.create();
  await h.envs.execute(oldEnv, [
    setLabel({ label: "Sektar" }),
    initialize({
      genericSubdomain: OLD_HOST,
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: "https://registry.vetra.io",
    }),
    setOwner({ address: HOLDER }),
    enableService({ type: "FUSION", prefix: "fusion" }),
    setFusionConfig({
      image: "cr.vetra.io/app-sektar/host",
      env: [
        { name: "PH_HOST", value: "cli", isSecret: false },
        { name: "ADMINS", value: HOLDER, isSecret: false },
      ],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
    approveChanges({}),
  ]);
  h.envs.setStatus(oldEnv, "READY");
  await seedLicensedEnvironment(h, {
    appId,
    root: "l1",
    environmentId: oldEnv,
  });
  await h.envs.execute(oldEnv, [
    setManagedBy({
      appId,
      templateId: "template-1",
      rootLicenseId: "l1",
      services: ["FUSION"],
    }),
  ]);
  await insertPlan(h.db, {
    id: "p1",
    app_id: appId,
    slug: "cloud",
    name: "Cloud",
    kind: "sektar-cloud",
    access: "own",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: "0xa",
    created_at: "t",
    updated_at: "t",
  });
  h.deps.docs = {
    exists: async () => true,
    getState: async () => ({
      templates: [{ id: "template-1", mode: "DEDICATED" }],
      terms: [{ kind: "sektar-cloud", templateId: "template-1" }],
    }),
  } as never;
  if (o.frozen !== false)
    await freezeAppReleases(
      { store: createRolloutStore(h.deps.licensingDb!), now: () => "t" },
      appId,
      "switch-over",
    );

  const backups = fakeSwitchoverBackups({ auto: true });
  const counts = fakeCounts();
  // The old environment's /data holds its two kept keys.
  backups.files.set(
    OLD_TENANT,
    new Map([
      [KEY_FILES[0], Buffer.from(`${MASTER}\n`)],
      [KEY_FILES[1], Buffer.from(ATTACH)],
    ]),
  );
  h.tenants.set(oldEnv, OLD_TENANT);
  const cluster = {
    oldPod: "app-0" as string | null,
    dbReady: new Set<string>(),
    volumeBound: new Set<string>(),
    /** Tenants whose app pod is Running and Ready. */
    ready: new Set<string>([OLD_TENANT]),
  };
  const ports: SwitchoverPorts = {
    backups: backups.api,
    counts: counts.runner,
    storage: {
      databaseReady: async (t) => cluster.dbReady.has(t),
      dataVolumeBound: async (t) => cluster.volumeBound.has(t),
    },
    dataPvc: async (t) => `powerhouse-${t}-app-data`,
    runningAppPod: async (t) => (t === OLD_TENANT ? cluster.oldPod : null),
    appPodReady: async (t) => cluster.ready.has(t),
  };
  h.deps.switchover = ports;

  const obs = h.obsDb as Kysely<ObservabilityDB>;
  /** Observability's view of the old tenant: a running app pod, or none (status fresh). */
  const setOldPod = async (present: boolean) => {
    cluster.oldPod = present ? "app-0" : null;
    await obs
      .deleteFrom("environment_pods")
      .where("tenantId", "=", OLD_TENANT)
      .execute();
    await obs
      .deleteFrom("environment_status")
      .where("tenantId", "=", OLD_TENANT)
      .execute();
    const at = h.deps.now().toISOString();
    if (present)
      await (obs as Kysely<any>)
        .insertInto("environment_pods")
        .values({
          id: `${OLD_TENANT}/app-0`,
          tenantId: OLD_TENANT,
          name: "app-0",
          service: "OTHER",
          component: "app",
          agent: null,
          phase: "Running",
          ready: 1,
          restartCount: 0,
          updatedAt: at,
        })
        .execute();
    await (obs as Kysely<any>)
      .insertInto("environment_status")
      .values({
        tenantId: OLD_TENANT,
        argoSyncStatus: "Synced",
        argoHealthStatus: "Healthy",
        configDriftDetected: 0,
        updatedAt: at,
      })
      .execute()
      .catch(() => undefined);
  };
  await setOldPod(true);
  // The old environment counts.
  counts.byTenant.set(OLD_TENANT, COUNTS);

  const sw = await insertSwitchover(
    h.db,
    switchoverRow({
      id: "sw1aaaaa-0000-0000-0000-000000000000",
      app_id: appId,
      environment_id: oldEnv,
      old_tenant: OLD_TENANT,
      old_host: OLD_HOST,
      licence_root_id: "l1",
      holder_address: HOLDER,
      kind: "sektar-cloud",
      plan_id: "p1",
      release_version: "1.4.0",
      release_digest: release.image_digest,
      mode: o.mode ?? "real",
      state: o.state ?? "PLANNED",
      window_start: new Date(
        h.deps.now().getTime() + 25 * 3_600_000,
      ).toISOString(),
      window_end: new Date(
        h.deps.now().getTime() + 28 * 3_600_000,
      ).toISOString(),
      step_started_at: h.deps.now().toISOString(),
    }),
  );
  /** One reconciler pass and one runner pass. */
  const tick = async () => {
    await reconcileInstancesOnce(h.deps);
    return advanceSwitchoversOnce(h.deps);
  };
  const row = async () =>
    (await h.db
      .selectFrom("switchovers")
      .selectAll()
      .where("id", "=", sw.id)
      .executeTakeFirstOrThrow()) as SwitchoverRow;
  const instance = async () => {
    const r = await row();
    return r.instance_id ? getInstance(h.db, r.instance_id) : null;
  };
  return {
    h,
    appId,
    oldEnv,
    release,
    backups,
    counts,
    cluster,
    sw,
    tick,
    row,
    instance,
    setOldPod,
    updateInstance: (id: string, patch: Parameters<typeof updateInstance>[2]) =>
      updateInstance(h.db, id, patch, h.deps.now().toISOString()),
  };
}
export type Flow = Awaited<ReturnType<typeof flow>>;

const HOUR = 3_600_000;
const TENANT_OF = async (f: Flow) => {
  const inst = await f.instance();
  return inst?.environment_id && inst.host
    ? getTenantId(inst.host, inst.environment_id)
    : null;
};
export { TENANT_OF as newTenantOf };

/**
 * Drives a switch-over through the happy path, playing the cluster (storage
 * ready, old pod gone, counts equal, the instance healthy), until it is in
 * `target`. Throws if it fails on the way.
 */
export async function drive(f: Flow, target: SwitchoverRow["state"]) {
  for (let i = 0; i < 80; i++) {
    const r = await f.row();
    if (r.state === target) return r;
    if (r.state === "FAILED")
      throw new Error(`failed in ${r.failed_state}: ${r.error}`);
    const tenant = await TENANT_OF(f);
    if (tenant) {
      f.cluster.dbReady.add(tenant);
      f.cluster.volumeBound.add(tenant);
      if (!f.counts.byTenant.has(tenant)) f.counts.byTenant.set(tenant, COUNTS);
    }
    if (r.state === "PLANNED") f.h.advance(2 * HOUR);
    if (r.state === "PREPARED") f.h.advance(24 * HOUR);
    if (r.state === "HOLDING_OLD") await f.setOldPod(false);
    if (r.state === "VERIFYING") {
      const inst = (await f.instance())!;
      await f.updateInstance(inst.id, {
        status: "ready",
        running_version: inst.target_version,
        running_digest: inst.target_digest,
        running_degraded: false,
      });
      await advanceSwitchoversOnce(f.h.deps);
    } else await f.tick();
  }
  throw new Error(`did not reach ${target}`);
}
