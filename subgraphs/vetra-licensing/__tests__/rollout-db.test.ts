import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type {
  AppRollouts,
  EnvironmentUpdates,
  VetraLicensingDB,
} from "../db/schema.js";
import {
  createRolloutStore,
  releasePolicyOf,
  type RolloutStore,
} from "../rollout-db.js";

const T0 = "2026-11-10T00:00:00.000Z";
const T1 = "2026-11-10T01:00:00.000Z";
const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1",
  app_id: "a",
  artifact_name: "web",
  version: "1.1.0",
  status: "ACTIVE",
  apply_after: T1,
  promoted_by: "0xp",
  promoted_at: T0,
  paused_at: null,
  paused_reason: null,
  ...over,
});
const update = (
  over: Partial<EnvironmentUpdates> = {},
): EnvironmentUpdates => ({
  id: "u1",
  rollout_id: "r1",
  environment_id: "e1",
  app_id: "a",
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "PENDING",
  due_at: T1,
  requested_at: null,
  started_at: null,
  finished_at: null,
  pre_update_dump_id: null,
  error: null,
  forced_at: null,
  created_at: T0,
  ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
});
afterEach(async () => {
  await db.destroy();
});

describe("release settings", () => {
  it("reads AUTO with 72 hours for an app without a row, and saves over it", async () => {
    expect(await store.settings("a")).toStrictEqual({
      appId: "a",
      policy: "AUTO",
      defaultNoticeHours: 72,
    });
    await store.saveSettings(
      { appId: "a", policy: "GATED", defaultNoticeHours: 0 },
      T0,
    );
    await store.saveSettings(
      { appId: "a", policy: "GATED", defaultNoticeHours: 24 },
      T1,
    );
    expect(await store.settings("a")).toStrictEqual({
      appId: "a",
      policy: "GATED",
      defaultNoticeHours: 24,
    });
    expect(await releasePolicyOf(db, "a")).toBe("GATED");
    expect(await releasePolicyOf(db, "b")).toBe("AUTO");
  });

  it("reads AUTO when the licensing tables do not exist yet, and propagates anything else", async () => {
    const bare = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    expect(await releasePolicyOf(bare, "a")).toBe("AUTO");
    await bare.destroy();
    await expect(releasePolicyOf(bare, "a")).rejects.toThrow();
  });
});

describe("rollouts", () => {
  it("supersedes the artifact's ACTIVE and PAUSED rollouts on promotion, not other artifacts'", async () => {
    await store.promote(rollout({ id: "r1" }));
    await store.promote(rollout({ id: "other", artifact_name: "api" }));
    expect(await store.pause("r1", "e1 failed", T1)).toBe(true);
    await store.promote(
      rollout({ id: "r2", version: "1.2.0", promoted_at: T1 }),
    );
    expect((await store.rollout("r1"))!.status).toBe("SUPERSEDED");
    expect((await store.rollout("other"))!.status).toBe("ACTIVE");
    expect(await store.openRollout("a", "web", "1.2.0")).toMatchObject({
      id: "r2",
      status: "ACTIVE",
    });
    expect(await store.openRollout("a", "web", "1.1.0")).toBeNull();
    expect((await store.rolloutsOf("a")).map((r) => r.id)).toStrictEqual([
      "r2",
      "r1",
      "other",
    ]);
    expect(
      (await store.activeRollouts("a")).map((r) => r.id).sort(),
    ).toStrictEqual(["other", "r2"]);
  });

  it("pauses only an ACTIVE rollout, and resume returns its FAILED updates to PENDING", async () => {
    await store.promote(rollout());
    await store.insertUpdate(
      update({
        id: "u1",
        status: "FAILED",
        error: "boom",
        started_at: T0,
        finished_at: T1,
      }),
    );
    await store.insertUpdate(
      update({ id: "u2", environment_id: "e2", status: "SUCCEEDED" }),
    );
    expect(await store.resume("r1")).toBe(false);
    expect(await store.pause("r1", "environment e1: boom", T1)).toBe(true);
    expect(await store.pause("r1", "again", T1)).toBe(false);
    expect(await store.rollout("r1")).toMatchObject({
      status: "PAUSED",
      paused_at: T1,
      paused_reason: "environment e1: boom",
    });
    expect(await store.resume("r1")).toBe(true);
    expect(await store.rollout("r1")).toMatchObject({
      status: "ACTIVE",
      paused_at: null,
      paused_reason: null,
    });
    expect(await store.update("u1")).toMatchObject({
      status: "PENDING",
      error: null,
      started_at: null,
      finished_at: null,
    });
    expect((await store.update("u2"))!.status).toBe("SUCCEEDED");
  });

  it("counts open updates and updates by status; complete only moves an ACTIVE rollout", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ id: "u1", status: "PENDING" }));
    await store.insertUpdate(
      update({ id: "u2", environment_id: "e2", status: "APPLYING" }),
    );
    await store.insertUpdate(
      update({ id: "u3", environment_id: "e3", status: "SUCCEEDED" }),
    );
    expect(await store.openCount("r1")).toBe(2);
    expect(await store.countsByStatus("r1")).toStrictEqual([
      { status: "APPLYING", count: 1 },
      { status: "PENDING", count: 1 },
      { status: "SUCCEEDED", count: 1 },
    ]);
    await store.pause("r1", "x", T1);
    await store.complete("r1");
    expect((await store.rollout("r1"))!.status).toBe("PAUSED");
  });
});

describe("environment updates", () => {
  it("finds the rows the gate needs", async () => {
    await store.insertUpdate(
      update({
        id: "old",
        rollout_id: null,
        to_version: "1.1.0",
        status: "SUPERSEDED",
        created_at: T0,
      }),
    );
    await store.insertUpdate(
      update({
        id: "canary",
        rollout_id: null,
        to_version: "1.1.0",
        status: "SUCCEEDED",
        created_at: T1,
      }),
    );
    await store.insertUpdate(
      update({
        id: "r1e1",
        rollout_id: "r1",
        to_version: "1.2.0",
        status: "PENDING",
        created_at: T1,
      }),
    );
    await store.insertUpdate(
      update({
        id: "r1e2",
        rollout_id: "r1",
        environment_id: "e2",
        status: "APPLYING",
      }),
    );
    expect((await store.updateFor("r1", "e1"))!.id).toBe("r1e1");
    expect((await store.unrolledUpdate("e1", "1.1.0"))!.id).toBe("canary");
    expect(await store.unrolledUpdate("e1", "9.9.9")).toBeNull();
    expect((await store.openExcept("e1", null))!.id).toBe("r1e1");
    expect(await store.openExcept("e1", "r1e1")).toBeNull();
    expect(await store.anotherApplying("a", "e1")).toBe(true);
    expect(await store.anotherApplying("a", "e2")).toBe(false);
    expect((await store.applyingOf("a")).map((u) => u.id)).toStrictEqual([
      "r1e2",
    ]);
    // Same created_at: the larger id is newest.
    expect((await store.latest("e1"))!.id).toBe("r1e1");
    expect((await store.history("e1", 2)).map((u) => u.id)).toHaveLength(2);
  });

  it("releases only an APPLYING update, and finishes only an APPLYING one", async () => {
    await store.insertUpdate(
      update({ id: "u1", status: "APPLYING", started_at: T0 }),
    );
    await store.releaseApplying("u1");
    expect(await store.update("u1")).toMatchObject({
      status: "PENDING",
      started_at: null,
    });
    await store.finishUpdate("u1", "SUCCEEDED", null, T1);
    expect((await store.update("u1"))!.status).toBe("PENDING");
    await store.patchUpdate("u1", { status: "APPLYING", started_at: T0 });
    await store.finishUpdate("u1", "FAILED", "deployment failed", T1);
    expect(await store.update("u1")).toMatchObject({
      status: "FAILED",
      error: "deployment failed",
      finished_at: T1,
    });
  });

  it("runs gate writes in one transaction: a failure leaves nothing behind", async () => {
    await expect(
      store.inTransaction(async (q) => {
        await q.insertUpdate(update({ id: "u1" }));
        await q.insertUpdate(update({ id: "u1" }));
      }),
    ).rejects.toThrow();
    expect(await store.update("u1")).toBeNull();
  });
});
