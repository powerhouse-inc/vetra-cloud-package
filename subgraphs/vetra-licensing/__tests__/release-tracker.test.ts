import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type {
  AppRollouts,
  EnvironmentUpdates,
  LicenseEnvironments,
  VetraLicensingDB,
} from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { createRolloutStore, type RolloutStore } from "../rollout-db.js";
import { trackReleases, type ReleaseTrackerDeps } from "../release-tracker.js";

const T0 = "2026-11-10T12:00:00.000Z";
const T1 = "2026-11-10T12:05:00.000Z";
const LATE = "2026-11-10T13:00:00.000Z";
const STRANDED =
  "FUSION 0.9.0 is not in the app's record (...); the publisher can force the update";
const APP: AppDocView = {
  id: "a",
  name: "Sektar",
  slug: "sektar",
  owner: "0xo",
  status: "ACTIVE",
  identityDid: null,
  productionEnvironmentId: null,
  templates: [
    {
      id: "t",
      name: null,
      mode: "DEDICATED",
      sharedEnvironment: null,
      warmPoolSize: 0,
      templateHash: "h-new",
      resolutionError: null,
      template: {
        services: [],
        packages: [],
        size: null,
        baseDomain: null,
        packageRegistry: null,
      },
    },
  ],
  terms: [],
  artifacts: [
    {
      kind: "FUSION_IMAGE",
      name: "host",
      versions: [{ version: "1.1.0", reference: "cr.vetra.io/p/host:1.1.0" }],
      channels: [{ channel: "LATEST", version: "1.1.0" }],
    },
  ],
  tampered: false,
  tamperReason: null,
  licensingStateHash: "x",
  unverified: false,
};
const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1",
  app_id: "a",
  artifact_name: "host",
  version: "1.1.0",
  status: "ACTIVE",
  apply_after: T0,
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
  status: "APPLYING",
  due_at: T0,
  requested_at: null,
  started_at: T0,
  finished_at: null,
  pre_update_dump_id: null,
  error: null,
  forced_at: null,
  created_at: T0,
  ...over,
});
const envRow = (
  over: Partial<LicenseEnvironments> = {},
): LicenseEnvironments => ({
  environment_id: "e1",
  root_license_id: "l1",
  app_id: "a",
  user_did: "u",
  license_id: "l1",
  template_id: "t",
  label: null,
  template_hash: "h-new",
  channel_override: null,
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: T0,
  updated_at: T0,
  ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
let states: Map<string, { status: string; version: string | null }>;
let deps: ReleaseTrackerDeps;
let clock: string;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
  states = new Map();
  clock = T1;
  deps = {
    store,
    envState: async (id) => {
      const s = states.get(id);
      return s
        ? ({
            status: s.status,
            services: [{ type: "FUSION", version: s.version }],
          } as never)
        : null;
    },
    cfg: { updateTimeoutMs: 20 * 60 * 1000 },
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => clock,
  };
});
afterEach(async () => {
  await db.destroy();
});

describe("trackReleases", () => {
  it("marks an update SUCCEEDED once its environment is READY on the version, and completes the rollout", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.update("u1"))!.status).toBe("APPLYING");
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({
      status: "SUCCEEDED",
      finished_at: T1,
      error: null,
    });
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("rollout r1 of app a (host 1.1.0) is complete"),
    );
  });

  it("clears the stranded error of an update that then succeeds", async () => {
    await store.insertUpdate(
      update({ rollout_id: null, error: STRANDED, forced_at: T0 }),
    );
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({
      status: "SUCCEEDED",
      error: null,
    });
  });

  it("fails a deployment that failed and pauses its rollout, naming the environment", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    await store.insertUpdate(
      update({
        id: "u2",
        environment_id: "e2",
        status: "PENDING",
        started_at: null,
      }),
    );
    states.set("e1", { status: "DEPLOYMENt_FAILED", version: "1.1.0" });
    await trackReleases(deps, APP, [
      envRow(),
      envRow({ environment_id: "e2", root_license_id: "l2" }),
    ]);
    expect(await store.update("u1")).toMatchObject({
      status: "FAILED",
      error: "the deployment of 1.1.0 failed",
    });
    expect(await store.rollout("r1")).toMatchObject({
      status: "PAUSED",
      paused_reason: "environment e1: the deployment of 1.1.0 failed",
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("rollout r1 of app a is paused"),
    );
  });

  it("fails an update that is not READY within the timeout", async () => {
    await store.insertUpdate(update({ rollout_id: null }));
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    clock = LATE;
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({
      status: "FAILED",
      error: "not READY on 1.1.0 within 20 minutes",
    });
  });

  it("does not complete a rollout while a customer is still PENDING, or behind its template", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    expect(
      await store.transitionUpdate("u1", "PENDING", { status: "SUCCEEDED" }),
    ).toBe(true);
    // An environment the keeper has not visited since the promotion.
    await trackReleases(deps, APP, [
      envRow(),
      envRow({
        environment_id: "e2",
        root_license_id: "l2",
        template_hash: "h-old",
      }),
    ]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    // Canaries and ended chains do not count.
    await trackReleases(deps, APP, [
      envRow(),
      envRow({
        environment_id: "e2",
        root_license_id: "l2",
        template_hash: "h-old",
        channel_override: "STAGING",
      }),
      envRow({
        environment_id: "e3",
        root_license_id: "l3",
        template_hash: "h-old",
        ended_at: T0,
      }),
    ]);
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("does not complete a rollout LATEST does not point at yet (promoted after the app was read)", async () => {
    await store.promote(rollout({ version: "1.2.0" }));
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
  });
});

describe("trackReleases: a resumed update whose environment already runs its version", () => {
  it("succeeds once that environment is READY again, and only then", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    states.set("e1", { status: "DEPLOYMENt_FAILED", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.update("u1"))!.status).toBe("PENDING");
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({
      status: "SUCCEEDED",
      finished_at: T1,
    });
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("clears the stranded error of a PENDING update whose environment already runs its version", async () => {
    await store.insertUpdate(
      update({
        status: "PENDING",
        started_at: null,
        rollout_id: null,
        error: STRANDED,
      }),
    );
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({
      status: "SUCCEEDED",
      error: null,
    });
  });

  it("leaves a PENDING update of an environment that is behind to the keeper", async () => {
    await store.insertUpdate(
      update({ status: "PENDING", started_at: null, rollout_id: null }),
    );
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow({ template_hash: "h-old" })]);
    expect((await store.update("u1"))!.status).toBe("PENDING");
  });
});

describe("trackReleases: open updates of environments that are no longer live", () => {
  const closed = {
    status: "SUPERSEDED",
    finished_at: T1,
    error: "environment ended",
  };

  it("closes a PENDING update of an ended chain, and the rollout then completes", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    await trackReleases(deps, APP, [envRow({ ended_at: T0 })]);
    expect(await store.update("u1")).toMatchObject(closed);
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("environment e1"),
    );
  });

  it("closes an APPLYING update of an ended chain past the timeout instead of failing it, and pauses nothing", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    clock = LATE;
    await trackReleases(deps, APP, [envRow({ ended_at: T0 })]);
    expect(await store.update("u1")).toMatchObject({
      ...closed,
      finished_at: LATE,
    });
    expect((await store.rollout("r1"))!.status).not.toBe("PAUSED");
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("closes an update whose environment row is gone", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    await trackReleases(deps, APP, []);
    expect(await store.update("u1")).toMatchObject(closed);
  });

  it("leaves a live environment's open updates alone", async () => {
    await store.promote(rollout());
    const pending = update({ status: "PENDING", started_at: null });
    const applying = update({ id: "u2", environment_id: "e2" });
    await store.insertUpdate(pending);
    await store.insertUpdate(applying);
    states.set("e1", { status: "READY", version: "1.0.0" });
    states.set("e2", { status: "DEPLOYING", version: "1.1.0" });
    await trackReleases(deps, APP, [
      envRow(),
      envRow({ environment_id: "e2", root_license_id: "l2" }),
    ]);
    expect(await store.update("u1")).toStrictEqual(pending);
    expect(await store.update("u2")).toStrictEqual(applying);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
  });

  it("closes a canary's open update of an ended chain too", async () => {
    await store.insertUpdate(update({ rollout_id: null }));
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    await trackReleases(deps, APP, [
      envRow({ channel_override: "STAGING", ended_at: T0 }),
    ]);
    expect(await store.update("u1")).toMatchObject(closed);
  });
});

describe("trackReleases: another writer moved the row first", () => {
  // The real store, with one write reporting that it moved nothing (the gate
  // released or superseded the row, or an overlapping run settled it).
  const lost = (method: "finishUpdate" | "complete" | "transitionUpdate") => {
    const spy = vi.fn(async () => false);
    deps.store = { ...store, [method]: spy };
    return spy;
  };

  it("neither logs nor pauses a failure it did not record", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    states.set("e1", { status: "DEPLOYMENt_FAILED", version: "1.1.0" });
    const finish = lost("finishUpdate");
    await trackReleases(deps, APP, [envRow()]);
    expect(finish).toHaveBeenCalledWith(
      "u1",
      "FAILED",
      "the deployment of 1.1.0 failed",
      T1,
    );
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("does not log a success it did not record", async () => {
    await store.insertUpdate(update({ rollout_id: null }));
    states.set("e1", { status: "READY", version: "1.1.0" });
    const finish = lost("finishUpdate");
    await trackReleases(deps, APP, [envRow()]);
    expect(finish).toHaveBeenCalledWith("u1", "SUCCEEDED", null, T1);
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("does not log a PENDING update's success it did not record", async () => {
    await store.insertUpdate(
      update({ status: "PENDING", started_at: null, rollout_id: null }),
    );
    states.set("e1", { status: "READY", version: "1.1.0" });
    const finish = lost("finishUpdate");
    await trackReleases(deps, APP, [envRow()]);
    expect(finish).toHaveBeenCalledWith("u1", "SUCCEEDED", null, T1, "PENDING");
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("neither logs nor settles an ended chain's update it did not close", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    clock = LATE;
    const transition = lost("transitionUpdate");
    const finish = vi.fn(store.finishUpdate);
    deps.store = { ...deps.store, finishUpdate: finish };
    await trackReleases(deps, APP, [envRow({ ended_at: T0 })]);
    expect(transition).toHaveBeenCalledWith("u1", ["PENDING", "APPLYING"], {
      status: "SUPERSEDED",
      finished_at: LATE,
      error: "environment ended",
    });
    expect(finish).not.toHaveBeenCalled();
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    expect(deps.logger.info).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("does not log a completion it did not record", async () => {
    await store.promote(rollout());
    const complete = lost("complete");
    await trackReleases(deps, APP, [envRow()]);
    expect(complete).toHaveBeenCalledWith("r1");
    expect(deps.logger.info).not.toHaveBeenCalled();
  });
});
