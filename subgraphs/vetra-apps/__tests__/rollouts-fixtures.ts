import { expect } from "vitest";
import { DEFAULT_INSTANCE_HEALTH } from "../config.js";
import {
  getInstance,
  insertInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { insertPlan, type PlanRow } from "../plans/repo.js";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";

export const HOLDER_A = "0x1111111111111111111111111111111111111111";
export const HOLDER_B = "0x2222222222222222222222222222222222222222";
/** version, digest letter, run */
export const RELEASES = [
  ["1.4.0", "b", 100],
  ["1.4.1", "c", 110],
  ["1.5.0", "d", 120],
  ["2.0.0", "e", 130],
] as const;

export async function rolloutHarness(
  o: { health?: "enforce" | "report"; hold?: boolean } = {},
): Promise<{ h: Harness; appId: string }> {
  const h = await makeHarness(
    testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { ...DEFAULT_INSTANCE_HEALTH, mode: o.health ?? "enforce" },
      },
      plans: {
        enabled: true,
        stopAfterDays: 14,
        ...(o.hold ? { rolloutsHold: true } : {}),
      },
    }),
  );
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  for (const [version, letter, run] of RELEASES)
    await seedRelease(h, appId, {
      version,
      run,
      kind: "release",
      digest: digest(letter),
    });
  return { h, appId };
}

export function seedPlan(
  h: Harness,
  appId: string,
  over: Partial<PlanRow> & Pick<PlanRow, "id" | "slug" | "access">,
): Promise<PlanRow> {
  return insertPlan(h.db, {
    app_id: appId,
    name: over.slug,
    kind: over.slug,
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 0,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    update_window: null,
    policy_note: null,
    ...over,
  });
}

const release = (version: string) => {
  const r = RELEASES.find((x) => x[0] === version);
  if (!r) throw new Error(`no fixture release ${version}`);
  return { digest: digest(r[1]), run: r[2] };
};

/** A plan instance running `version` healthy, as the reconciler leaves it. */
export function readyInstance(
  h: Harness,
  appId: string,
  o: {
    id: string;
    planId: string;
    kind: "shared" | "own";
    version?: string;
    holder?: string;
    createdAt?: string;
  },
): Promise<InstanceRow> {
  const version = o.version ?? "1.4.0";
  const { digest: d, run } = release(version);
  return insertInstance(h.db, {
    id: o.id,
    app_id: appId,
    kind: o.kind,
    name: o.kind === "own" ? `own-${o.id}` : o.planId,
    branch: null,
    pr: null,
    host: `h-${o.id}`,
    environment_id: `env-${o.id}`,
    target_version: version,
    target_digest: d,
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: run,
    running_version: version,
    running_digest: d,
    running_repository: "cr.vetra.io/acme/shop",
    status: "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: o.planId,
    holder_address: o.holder ?? null,
    licence_root_id: o.kind === "own" ? `root-${o.id}` : null,
    created_at: o.createdAt ?? "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
}

/** What the reconciler writes once the instance runs its target healthy (health enforce). */
export const becomeReady = (h: Harness, id: string) =>
  h.db
    .updateTable("instances")
    .set((eb) => ({
      status: "ready",
      reason: null,
      running_version: eb.ref("target_version"),
      running_digest: eb.ref("target_digest"),
    }))
    .where("id", "=", id)
    .execute();

/** What the reconciler writes when the update failed (it also reverted the image to running_*). */
export const failUpdate = (
  h: Harness,
  id: string,
  reason = "unhealthy (crash: exit 1)",
) =>
  h.db
    .updateTable("instances")
    .set((eb) => ({
      status: "failed",
      reason,
      failed_digest: eb.ref("target_digest"),
    }))
    .where("id", "=", id)
    .execute();

export const instance = async (h: Harness, id: string) =>
  (await getInstance(h.db, id))!;

export const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});
