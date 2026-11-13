import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupHarness,
  driveRestores,
  finishBackupJobs,
  pass,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import {
  backupBeforeUpdate,
  backupProgress,
  backupsOn,
  restoreBackup,
  restoreProgress,
} from "../backups/rollout.js";
import { getInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("the rollout contract", () => {
  it("backupBeforeUpdate and restoreBackup, through their progress", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    expect(backupsOn(h.deps)).toBe(true);
    const id = await backupBeforeUpdate(h.deps, inst, "step-1");
    expect(await backupProgress(h.deps, id)).toEqual({ state: "pending" });
    await finishBackupJobs(h, fake);
    await pass(ctx);
    expect(await backupProgress(h.deps, id)).toMatchObject({
      state: "ready",
      version: "1.4.0",
    });
    const rid = await restoreBackup(
      h.deps,
      (await getInstance(h.db, "o1"))!,
      id,
      {
        purpose: "rollback",
        thenVersion: "1.4.0",
        stepId: "step-1",
      },
    );
    expect(await restoreProgress(h.deps, rid)).toEqual({
      state: "running",
      phase: "safety_backup",
    });
    await driveRestores(ctx);
    expect(await restoreProgress(h.deps, rid)).toEqual({ state: "succeeded" });
    expect(await backupProgress(h.deps, "nope")).toEqual({
      state: "failed",
      error: "the backup is gone",
    });
    h.advance(31 * 86_400_000);
    expect(await backupProgress(h.deps, id)).toEqual({
      state: "failed",
      error: "the backup expired",
    });
    h.deps.backups = null;
    expect(backupsOn(h.deps)).toBe(false);
  });
});
