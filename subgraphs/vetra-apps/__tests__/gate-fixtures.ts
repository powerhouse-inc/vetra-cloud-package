import type { GateConfig, VetraAppsConfig } from "../config.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import { insertPlan } from "../plans/repo.js";
import { syncPlanInstances } from "../plans/sync.js";
import { getApp } from "../repo.js";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";

export const GATE_ON: GateConfig = {
  enabled: true,
  url: "https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check",
  minPowerhouse: "6.2.3-dev.102",
};
export const PLANS_ON = { enabled: true, stopAfterDays: 14 };
export const SERVICE = "0x9999999999999999999999999999999999999999";

/** A harness with plans (and, unless told otherwise, the gate) on, an App on instances and release 1.4.0. */
export async function gateHarness(
  over: Partial<VetraAppsConfig> = { gate: GATE_ON },
): Promise<{ h: Harness; appId: string }> {
  const h = await makeHarness(testConfig({ plans: PLANS_ON, ...over }));
  h.deps.serviceOwner = SERVICE;
  const appId = (await seedActiveApp(h)).id;
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
  return { h, appId };
}

export const plan = (
  h: Harness,
  appId: string,
  over: Partial<Parameters<typeof insertPlan>[1]> = {},
) =>
  insertPlan(h.db, {
    id: "plan-shared",
    app_id: appId,
    slug: "starter",
    name: "Starter",
    kind: "starter",
    access: "shared",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  });

/** The plan rows sync made (shared and own), without reconciling. */
export async function syncPlans(
  h: Harness,
  appId: string,
): Promise<InstanceRow[]> {
  await syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
  return (await listInstances(h.db, appId)).filter(
    (r) => r.kind === "shared" || r.kind === "own",
  );
}
