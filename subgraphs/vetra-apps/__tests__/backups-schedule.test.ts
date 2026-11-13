import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupHarness,
  finishBackupJobs,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { getBackup } from "../backups/repo.js";
import { beginRestore, SYSTEM_WHO } from "../backups/restore.js";
import { runDailyBackupsOnce } from "../backups/schedule.js";
import { advanceBackups, startInstanceBackup } from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness({
    backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 1 },
  });
});
afterEach(async () => {
  await ctx.h.close();
});
const settle = async () => {
  await finishBackupJobs(ctx.h, ctx.fake);
  await advanceBackups(ctx.h.deps, ctx.appId);
};

describe("daily backups (spec 7: daily, kept 14 days)", () => {
  it("backs up each ready shared and own instance once a day, at most maxInFlight at a time", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await planInstance(h, fake, appId, { id: "s1", kind: "shared" });
    await planInstance(h, fake, appId, { id: "o3", status: "updating" });
    await planInstance(h, fake, appId, { id: "o4" });
    await updateInstance(
      h.db,
      "o4",
      { maintenance: "restore:r-9" },
      "2026-10-02T12:00:00.000Z",
    );
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]); // one in flight
    await settle();
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
    await settle();
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]); // both have today's
    const rows = await h.db
      .selectFrom("instance_backups")
      .select(["instance_id", "reason"])
      .orderBy("instance_id")
      .execute();
    expect(rows).toEqual([
      { instance_id: "o1", reason: "daily" },
      { instance_id: "s1", reason: "daily" },
    ]);
    h.advance(86_400_000);
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
  });

  it("retries a failed daily backup after an hour", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await runDailyBackupsOnce(h.deps);
    await finishBackupJobs(h, fake, "dump_failed");
    await advanceBackups(h.deps, appId);
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]);
    h.advance(3_600_000);
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
  });

  it("sweeps expired backups (S3 objects and rows) but keeps one a restore uses", async () => {
    const { h, appId, fake, deletedKeys } = ctx;
    const b = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o1" }),
      { reason: "daily", requestedBy: "vetra" },
    );
    await settle();
    const c = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o2" }),
      { reason: "daily", requestedBy: "vetra" },
    );
    await settle();
    await beginRestore(
      h.deps,
      (await getInstance(h.db, "o2"))!,
      (await getBackup(h.db, c.id))!,
      {
        purpose: "manual",
        thenVersion: null,
        who: SYSTEM_WHO,
      },
    );
    h.advance(15 * 86_400_000);
    expect((await runDailyBackupsOnce(h.deps)).deleted).toBe(1);
    expect(await getBackup(h.db, b.id)).toBeNull();
    expect(await getBackup(h.db, c.id)).not.toBeNull();
    expect(deletedKeys).toEqual([
      `t-o1/${b.dump_id}.dump`,
      `t-o1/data/${b.archive_id}.tar.zst`,
    ]);
    expect(
      await h.obsDb
        .selectFrom("database_dumps")
        .select("id")
        .where("id", "=", b.dump_id!)
        .execute(),
    ).toEqual([]);
    expect(
      await h.obsDb
        .selectFrom("data_archives")
        .select("id")
        .where("id", "=", b.archive_id!)
        .execute(),
    ).toEqual([]);
  });
});
