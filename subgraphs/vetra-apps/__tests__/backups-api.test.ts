import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger } from "./harness.js";
import {
  backupHarness,
  finishBackupJobs,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { listAudit } from "../audit/repo.js";
import {
  backUpInstanceFor,
  instanceBackupsFor,
  instanceRestoresFor,
  restoreInstanceBackupFor,
} from "../backups/api.js";
import { advanceBackups } from "../backups/service.js";
import { updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("instance backups API (spec 7: restored from the console)", () => {
  it("backs up now and restores, for operators only, with acceptDataLoss, a backup of the version it targets", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await expect(backUpInstanceFor(h.deps, stranger, "o1")).rejects.toThrow();
    const b = await backUpInstanceFor(h.deps, owner, "o1");
    expect(b).toMatchObject({
      instanceId: "o1",
      reason: "manual",
      status: "pending",
      version: "1.4.0",
    });
    for (const k of ["dumpId", "archiveId", "s3Key", "downloadUrl"])
      expect(b).not.toHaveProperty(k);
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toThrow(
      /already running/,
    );
    await finishBackupJobs(h, fake);
    await advanceBackups(h.deps, appId);
    expect(
      (await listAudit(h.db, appId, { limit: 10 })).map((a) => a.action),
    ).toContain("backup.requested");

    const restore = (accept: boolean) =>
      restoreInstanceBackupFor(h.deps, owner, {
        instanceId: "o1",
        backupId: b.id,
        acceptDataLoss: accept,
      });
    await expect(restore(false)).rejects.toThrow(/acceptDataLoss/);
    await expect(
      restoreInstanceBackupFor(h.deps, stranger, {
        instanceId: "o1",
        backupId: b.id,
        acceptDataLoss: true,
      }),
    ).rejects.toThrow();
    await updateInstance(
      h.db,
      "o1",
      { target_version: "1.5.0" },
      "2026-10-02T13:00:00.000Z",
    );
    await expect(restore(true)).rejects.toThrow(/taken on 1.4.0/);
    await updateInstance(
      h.db,
      "o1",
      { target_version: "1.4.0" },
      "2026-10-02T13:00:01.000Z",
    );
    const r = await restore(true);
    expect(r).toMatchObject({
      instanceId: "o1",
      backupId: b.id,
      purpose: "manual",
      status: "safety_backup",
      thenVersion: null,
    });
    await expect(restore(true)).rejects.toThrow(/being restored/);
    expect(
      (await instanceRestoresFor(h.deps, owner, "o1")).map((x) => x.id),
    ).toEqual([r.id]);
    expect(
      (await instanceBackupsFor(h.deps, owner, "o1")).map((x) => x.reason),
    ).toEqual(["manual"]);
    await expect(instanceBackupsFor(h.deps, stranger, "o1")).rejects.toThrow();
  });

  it("is not configured with backups off; branch instances have none", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await h.db
      .updateTable("instances")
      .set({ kind: "branch" })
      .where("id", "=", "o1")
      .execute();
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toThrow(
      /shared and own/,
    );
    await h.db
      .updateTable("instances")
      .set({ kind: "own" })
      .where("id", "=", "o1")
      .execute();
    h.deps.cfg = {
      ...h.deps.cfg,
      backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 },
    };
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
  });
});
