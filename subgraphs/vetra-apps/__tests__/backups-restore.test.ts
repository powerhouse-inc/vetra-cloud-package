import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_SHA,
  backupHarness,
  deployTarget,
  driveRestores,
  finishBackupJobs,
  pass,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { digest } from "./instances-fixtures.js";
import { listAudit } from "../audit/repo.js";
import {
  getBackup,
  getRestore,
  type InstanceBackupRow,
} from "../backups/repo.js";
import {
  beginRestore,
  RestoreBusyError,
  SYSTEM_WHO,
} from "../backups/restore.js";
import { startInstanceBackup } from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

/** o1 backed up on 1.4.0, then updated to 1.5.0 (the release that migrated it). */
async function updatedAfterBackup(): Promise<InstanceBackupRow> {
  const { h, appId, fake } = ctx;
  const inst = await planInstance(h, fake, appId, { id: "o1" });
  const b = await startInstanceBackup(h.deps, inst, {
    reason: "pre_update",
    requestedBy: "vetra",
  });
  await finishBackupJobs(h, fake);
  await pass(ctx);
  await updateInstance(
    h.db,
    "o1",
    {
      target_version: "1.5.0",
      target_digest: digest("b"),
      target_run: 2,
      running_version: "1.5.0",
      running_digest: digest("b"),
    },
    "2026-10-02T13:00:00.000Z",
  );
  fake.images.set("t-o1", [`cr.vetra.io/acme/shop:1.5.0@${digest("b")}`]);
  return (await getBackup(h.db, b.id))!;
}
const inst = async () => (await getInstance(ctx.h.db, "o1"))!;
const app0 = { "powerhouse-t-o1-app": 0 };
const app1 = { "powerhouse-t-o1-app": 1 };

describe("restoring a backup", () => {
  it("safety backup, app stopped, database then /data restored, handed back on the old release, started only on its image", async () => {
    const { h, appId, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, {
      purpose: "rollback",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    expect((await inst()).maintenance).toBe(`restore:${r.id}`);
    await pass(ctx);
    const safety = (await getRestore(h.db, r.id))!.safety_backup_id!;
    expect((await getBackup(h.db, safety))!.reason).toBe("pre_restore");
    expect(fake.scaled).toEqual([]);
    await finishBackupJobs(h, fake);
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("stopping");
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_db");
    const pg = fake.jobs.get(`pgrestore-${r.id}`)!.job.spec!.template.spec!
      .containers[0].env!;
    expect(pg.find((e) => e.name === "S3_KEY")!.value).toBe(
      `t-o1/${b.dump_id}.dump`,
    );
    fake.finish("pgrestore-");
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_data");
    const data = fake.jobs.get(`datarestore-${r.id}`)!.job.spec!.template.spec!;
    expect(
      data.containers[0].env!.find((e) => e.name === "ARCHIVE_SHA256")!.value,
    ).toBe(ARCHIVE_SHA);
    expect(data.volumes![0].persistentVolumeClaim!.claimName).toBe(
      "powerhouse-t-o1-app-data",
    );
    fake.finish("datarestore-");
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("starting");
    await pass(ctx);
    expect(await inst()).toMatchObject({
      maintenance: null,
      status: "updating",
      target_version: "1.4.0",
      target_digest: digest("a"),
      running_version: "1.4.0",
      running_digest: digest("a"),
    });
    await pass(ctx);
    // The cluster still runs the image that migrated: never started on the restored data.
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    await deployTarget(h, fake, "o1");
    await pass(ctx);
    expect(fake.deployments.get("t-o1")).toEqual(app1);
    await pass(ctx);
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "succeeded",
      error: null,
      held: false,
    });
    const actions = (await listAudit(h.db, appId, { limit: 50 })).map(
      (a) => a.action,
    );
    expect(actions.filter((a) => a.startsWith("restore."))).toEqual([
      "restore.finished",
      "restore.started",
    ]);
  });

  it("a failed database restore changes nothing: the app runs again on what it ran", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, {
      purpose: "rollback",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    await driveRestores(ctx, { fail: "pgrestore-" });
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: false,
      error: "database restore failed: psql: ERROR: boom; nothing was changed",
    });
    expect(await inst()).toMatchObject({
      maintenance: null,
      target_version: "1.5.0",
    });
    expect(fake.deployments.get("t-o1")).toEqual(app1);
  });

  it("a failed /data restore holds the instance stopped; a new restore may start, and its early failure keeps it held", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, {
      purpose: "rollback",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    await driveRestores(ctx, { fail: "datarestore-" });
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: true,
    });
    expect(await inst()).toMatchObject({
      maintenance: `held:${r.id}`,
      status: "failed",
      reason: expect.stringMatching(
        /^restore failed: \/data restore failed: archive checksum mismatch/,
      ),
    });
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    const again = await beginRestore(h.deps, await inst(), b, {
      purpose: "manual",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    expect(again.was_held).toBe(true);
    await driveRestores(ctx, { fail: "pgdump-" });
    expect(await getRestore(h.db, again.id)).toMatchObject({
      status: "failed",
      held: true,
      error: expect.stringMatching(/safety backup failed/),
    });
    expect((await inst()).maintenance).toBe(`held:${again.id}`);
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });

  it("refuses another instance's backup, a backup that is not ready, and a second restore", async () => {
    const { h, appId, fake } = ctx;
    const b = await updatedAfterBackup();
    const other = await planInstance(h, fake, appId, { id: "o2" });
    await expect(
      beginRestore(h.deps, other, b, {
        purpose: "manual",
        thenVersion: null,
        who: SYSTEM_WHO,
      }),
    ).rejects.toThrow(/not a backup of o2/);
    await expect(
      beginRestore(
        h.deps,
        await inst(),
        { ...b, status: "pending" },
        { purpose: "manual", thenVersion: null, who: SYSTEM_WHO },
      ),
    ).rejects.toThrow(/is pending/);
    await beginRestore(h.deps, await inst(), b, {
      purpose: "manual",
      thenVersion: null,
      who: SYSTEM_WHO,
    });
    await expect(
      beginRestore(h.deps, await inst(), b, {
        purpose: "manual",
        thenVersion: null,
        who: SYSTEM_WHO,
      }),
    ).rejects.toBeInstanceOf(RestoreBusyError);
  });
});
