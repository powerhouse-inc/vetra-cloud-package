import {
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { insertInstance, type NewInstance } from "../instances/repo.js";
import { insertPlan } from "../plans/repo.js";
import { warmInstanceName } from "../plans/pool.js";

export const HOLDER = "0x1111111111111111111111111111111111111111";

/** Plans on, pools capped at 2, health report; release 1.4.0 and an own plan "p-pro" (M) on it with a pool of 1. */
export async function poolHarness(
  over: { poolMax?: number; warmPoolSize?: number } = {},
): Promise<{ h: Harness; appId: string }> {
  const h = await makeHarness(
    testConfig({
      plans: {
        enabled: true,
        stopAfterDays: 14,
        poolMax: over.poolMax ?? 2,
      },
      instances: {
        enabled: true,
        labelSuffix: "",
        health: {
          mode: "report",
          unhealthyWindowMs: 300_000,
          probesPerPass: 10,
          probesPerApp: 3,
        },
      },
    }),
  );
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
  await insertPlan(h.db, {
    id: "p-pro",
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
    warm_pool_size: over.warmPoolSize ?? 1,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  return { h, appId };
}

/** A ready warm row with a host and an environment, on the plan's target. */
export async function seedWarm(
  h: Harness,
  appId: string,
  over: Partial<NewInstance> = {},
) {
  const id = over.id ?? h.deps.newId();
  return insertInstance(h.db, {
    id,
    app_id: appId,
    kind: "own",
    name: warmInstanceName(id),
    branch: null,
    pr: null,
    host: `calm-bat-${id.slice(-4)}`,
    environment_id: `env-${id}`,
    target_version: "1.4.0",
    target_digest: digest("b"),
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: 100,
    running_version: "1.4.0",
    running_digest: digest("b"),
    running_repository: "cr.vetra.io/acme/shop",
    status: "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: "p-pro",
    holder_address: null,
    licence_root_id: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: "VETRA_AGENT_M",
    warm: true,
    created_at: "2026-11-12T00:00:00.000Z",
    updated_at: "2026-11-12T00:00:00.000Z",
    ...over,
  });
}
