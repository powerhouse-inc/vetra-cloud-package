import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type {
  EnvironmentUpdates,
  LicenseEnvironments,
  VetraLicensingDB,
} from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import {
  forceEnvironmentUpdate,
  freezeAppReleases,
  promoteRelease,
  requestUpdateNow,
  resumeRollout,
  unfreezeAppReleases,
  type ReleaseServiceDeps,
} from "../release-service.js";
import { createRolloutStore, frozenReasonOf } from "../rollout-db.js";
import { createUpdateGate } from "../update-gate.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-11T12:00:00.000Z";
const MOVE = {
  artifactName: "host",
  from: "1.0.0",
  to: "1.1.0",
  stranded: false,
};
const REASON = "Sektar switch-over";

const envRow = (
  environment_id: string,
  app_id: string,
): LicenseEnvironments => ({
  environment_id,
  root_license_id: `l-${environment_id}`,
  app_id,
  user_did: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
  license_id: `l-${environment_id}`,
  template_id: "t",
  label: null,
  template_hash: "h",
  channel_override: null,
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: NOW,
  updated_at: NOW,
});
const update = (
  over: Partial<EnvironmentUpdates> = {},
): EnvironmentUpdates => ({
  id: "u1",
  rollout_id: null,
  environment_id: "cust",
  app_id: "a",
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "PENDING",
  due_at: NOW,
  requested_at: null,
  started_at: null,
  finished_at: null,
  pre_update_dump_id: null,
  error: null,
  forced_at: null,
  created_at: NOW,
  ...over,
});

let db: Kysely<VetraLicensingDB>;
let deps: ReleaseServiceDeps;
let kicks: number;
let clock: string;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  kicks = 0;
  clock = NOW;
  deps = {
    store: createRolloutStore(db),
    envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
    apps: { app: async () => null },
    appWriter: { appendLicensingOps: async () => {} },
    envState: async () => null,
    kick: () => {
      kicks++;
    },
    newId: () => "r1",
    now: () => clock,
  } as unknown as ReleaseServiceDeps;
  await db
    .insertInto("license_environments")
    .values([envRow("cust", "a"), envRow("other", "b")])
    .execute();
});
afterEach(async () => {
  await db.destroy();
});

const pausedRollout = async () => {
  await deps.store.promote({
    id: "r1",
    app_id: "a",
    artifact_name: "host",
    version: "1.1.0",
    status: "ACTIVE",
    apply_after: NOW,
    promoted_by: "0xp",
    promoted_at: NOW,
    paused_at: null,
    paused_reason: null,
  });
  await deps.store.pause("r1", "x", NOW);
};

describe("the default: no freeze", () => {
  it("reads as not frozen and leaves every action as it was", async () => {
    expect((await deps.store.settings("a")).frozenReason).toBeNull();
    expect(await frozenReasonOf(db, "a")).toBeNull();
    await pausedRollout();
    expect(await resumeRollout(deps, { appId: "a", rolloutId: "r1" })).toBe(
      true,
    );
    await deps.store.insertUpdate(update());
    expect(await requestUpdateNow(deps, envRow("cust", "a"))).toBe(true);
    await expect(
      promoteRelease(deps, {
        appId: "a",
        artifactName: "host",
        version: "1.1.0",
        promotedBy: "0xp",
      }),
    ).rejects.toThrow(/not gated/);
  });

  it("the gate admits an AUTO app's move as before", async () => {
    const gate = createUpdateGate({
      store: deps.store,
      logger: { info: () => {}, warn: () => {} },
      newId: () => "u9",
    });
    expect(
      await gate.admit({ row: envRow("cust", "a"), move: MOVE, now: NOW }),
    ).toStrictEqual({ version: "floor", updateId: "u9" });
  });
});

describe("a frozen App", () => {
  it("refuses promote, resume, force and update-now, naming the reason", async () => {
    await pausedRollout();
    await deps.store.insertUpdate(
      update({
        status: "FAILED",
        error: "boom",
        started_at: NOW,
        finished_at: NOW,
      }),
    );
    await freezeAppReleases(deps, "a", REASON);
    const frozen = new RegExp(`releases of this app are frozen: ${REASON}`);
    await expect(
      promoteRelease(deps, {
        appId: "a",
        artifactName: "host",
        version: "1.1.0",
        promotedBy: "0xp",
      }),
    ).rejects.toThrow(frozen);
    await expect(
      resumeRollout(deps, { appId: "a", rolloutId: "r1" }),
    ).rejects.toThrow(frozen);
    await expect(
      forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
    ).rejects.toThrow(frozen);
    await expect(requestUpdateNow(deps, envRow("cust", "a"))).rejects.toThrow(
      frozen,
    );
    expect(await deps.store.update("u1")).toMatchObject({ status: "FAILED" });
    expect((await deps.store.rollout("r1"))?.status).toBe("PAUSED");
  });

  it("the update gate holds the App's environments and records nothing; another App moves", async () => {
    await freezeAppReleases(deps, "a", REASON);
    const gate = createUpdateGate({
      store: deps.store,
      logger: { info: () => {}, warn: () => {} },
      newId: () => "u9",
    });
    expect(
      await gate.admit({ row: envRow("cust", "a"), move: MOVE, now: NOW }),
    ).toStrictEqual({ version: "hold", updateId: null });
    expect(await deps.store.update("u9")).toBeNull();
    expect(
      await gate.admit({ row: envRow("other", "b"), move: MOVE, now: NOW }),
    ).toStrictEqual({ version: "floor", updateId: "u9" });
  });

  it("unfreezing restores every action", async () => {
    await pausedRollout();
    await deps.store.insertUpdate(update({ id: "u2", environment_id: "cust" }));
    await freezeAppReleases(deps, "a", REASON);
    kicks = 0;
    await unfreezeAppReleases(deps, "a");
    expect(kicks).toBe(1);
    expect(await frozenReasonOf(db, "a")).toBeNull();
    expect(await resumeRollout(deps, { appId: "a", rolloutId: "r1" })).toBe(
      true,
    );
    expect(await requestUpdateNow(deps, envRow("cust", "a"))).toBe(true);
    const gate = createUpdateGate({
      store: deps.store,
      logger: { info: () => {}, warn: () => {} },
      newId: () => "u9",
    });
    expect(
      (await gate.admit({ row: envRow("other", "b"), move: MOVE, now: NOW }))
        .version,
    ).toBe("floor");
  });

  it("freezing twice keeps the first reason and time; the policy is untouched", async () => {
    await deps.store.saveSettings(
      { appId: "a", policy: "GATED", defaultNoticeHours: 24 },
      NOW,
    );
    await freezeAppReleases(deps, "a", REASON);
    clock = LATER;
    await freezeAppReleases(deps, "a", "another");
    const row = await db
      .selectFrom("app_release_settings")
      .selectAll()
      .where("app_id", "=", "a")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      policy: "GATED",
      default_notice_hours: 24,
      frozen_reason: REASON,
      frozen_at: NOW,
    });
  });

  it("saving the policy keeps the freeze", async () => {
    await freezeAppReleases(deps, "a", REASON);
    await deps.store.saveSettings(
      { appId: "a", policy: "AUTO", defaultNoticeHours: 12 },
      LATER,
    );
    expect(await frozenReasonOf(db, "a")).toBe(REASON);
  });

  it("freezes only its own App", async () => {
    await freezeAppReleases(deps, "a", REASON);
    expect(await frozenReasonOf(db, "b")).toBeNull();
  });
});
