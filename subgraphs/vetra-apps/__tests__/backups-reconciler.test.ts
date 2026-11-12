import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupHarness,
  finishBackupJobs,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { getBackup, listBackupsOfInstance } from "../backups/repo.js";
import {
  beforePlanInstanceStop,
  startInstanceBackup,
} from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import {
  reconcileInstance,
  reconcileInstancesOnce,
} from "../instances/reconciler.js";
import { settingsForKind } from "../settings/resolve.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("instances in maintenance", () => {
  it("are left alone by the reconciler (a restore owns them)", async () => {
    const { h, appId, fake, app } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    // seedActiveApp made the App's own environment document.
    const docs = h.envs.docs.size;
    // Without maintenance this row would get a new environment.
    await updateInstance(
      h.db,
      "o1",
      { environment_id: null, status: "pending", maintenance: "held:r-1" },
      "2026-10-02T12:00:00.000Z",
    );
    await reconcileInstance(
      h.deps,
      await app(),
      (await getInstance(h.db, "o1"))!,
      settingsForKind([], "own"),
    );
    expect(h.envs.docs.size).toBe(docs);
    expect((await getInstance(h.db, "o1"))!.status).toBe("pending");
  });
});

describe("the per-App pass", () => {
  it("settles the App's backups (and advances its restores) with plans on", async () => {
    const { h, appId, fake } = ctx;
    const b = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o1" }),
      {
        reason: "manual",
        requestedBy: "vetra",
      },
    );
    await finishBackupJobs(h, fake);
    await reconcileInstancesOnce(h.deps);
    expect((await getBackup(h.db, b.id))!.status).toBe("ready");
  });
});

describe("beforePlanInstanceStop (TODO hook for the stop path, decision B9)", () => {
  it("is a no-op with backups off; with them on it starts a pre_stop backup and returns its id", async () => {
    const { h, appId, fake } = ctx;
    const row = await planInstance(h, fake, appId, { id: "o1" });
    const id = await beforePlanInstanceStop(h.deps, row);
    expect(id).not.toBeNull();
    expect((await listBackupsOfInstance(h.db, "o1", 5))[0]).toMatchObject({
      id,
      reason: "pre_stop",
      status: "pending",
    });
    await finishBackupJobs(h, fake);
    h.deps.cfg = {
      ...h.deps.cfg,
      backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 },
    };
    expect(await beforePlanInstanceStop(h.deps, row)).toBeNull();
    h.deps.cfg = {
      ...h.deps.cfg,
      backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 },
    };
    h.deps.backups = null;
    expect(await beforePlanInstanceStop(h.deps, row)).toBeNull();
    expect(await listBackupsOfInstance(h.db, "o1", 5)).toHaveLength(1);
  });
});
