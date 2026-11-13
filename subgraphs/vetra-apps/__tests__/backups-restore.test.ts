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
import { getHold } from "../holds/repo.js";
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
    // The environment is held: no app pod is rendered.
    expect(await getHold(h.db, "env-o1")).toMatchObject({ reason: "restore failed", created_by: "vetra" });
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
    expect(await getHold(h.db, "env-o1")).not.toBeNull();
    // A good restore hands back and releases the hold.
    const good = await beginRestore(h.deps, await inst(), b, {
      purpose: "manual",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    await driveRestores(ctx);
    expect((await getRestore(h.db, good.id))!.status).toBe("succeeded");
    expect(await getHold(h.db, "env-o1")).toBeNull();
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
    await expect(
      beginRestore(
        h.deps,
        await inst(),
        { ...b, environment_id: "env-o2" },
        { purpose: "manual", thenVersion: null, who: SYSTEM_WHO },
      ),
    ).rejects.toThrow(/another environment/);
    await expect(
      beginRestore(
        h.deps,
        await inst(),
        { ...b, tenant_id: "t-o2" },
        { purpose: "manual", thenVersion: null, who: SYSTEM_WHO },
      ),
    ).rejects.toThrow(/another namespace/);
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

/** Starts a rollback restore of o1 and passes until it is in `phase`. */
async function restoreUntil(phase: "restoring_db" | "restoring_data") {
  const { h, fake } = ctx;
  const b = await updatedAfterBackup();
  const r = await beginRestore(h.deps, await inst(), b, {
    purpose: "rollback",
    thenVersion: "1.4.0",
    who: SYSTEM_WHO,
  });
  for (let i = 0; i < 20; i++) {
    await finishBackupJobs(h, fake);
    if (phase === "restoring_data") fake.finish("pgrestore-");
    await pass(ctx);
    if ((await getRestore(h.db, r.id))!.status === phase) return { r, b };
  }
  throw new Error(`never reached ${phase}`);
}

describe("a restore Job that is missing", () => {
  it("holds the instance stopped when the database Job is gone: the outcome is unknown", async () => {
    const { h, fake } = ctx;
    const { r } = await restoreUntil("restoring_db");
    fake.jobs.delete(`pgrestore-${r.id}`);
    await pass(ctx);
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: true,
      error: expect.stringMatching(/outcome is unknown/),
    });
    expect((await inst()).maintenance).toBe(`held:${r.id}`);
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });

  it("holds the instance stopped when the /data Job is gone", async () => {
    const { h, fake } = ctx;
    const { r } = await restoreUntil("restoring_data");
    fake.jobs.delete(`datarestore-${r.id}`);
    await pass(ctx);
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: true,
    });
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });

  it("a database Job that timed out while running is unknown too, not 'nothing changed'", async () => {
    const { h, fake } = ctx;
    const { r } = await restoreUntil("restoring_db");
    await h.db
      .updateTable("instance_restores")
      .set({ phase_started_at: "2020-01-01T00:00:00.000Z" })
      .where("id", "=", r.id)
      .execute();
    await pass(ctx);
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: true,
    });
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });

  it("deletes its Jobs when it finishes", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, {
      purpose: "rollback",
      thenVersion: "1.4.0",
      who: SYSTEM_WHO,
    });
    await driveRestores(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("succeeded");
    expect(fake.jobs.has(`pgrestore-${r.id}`)).toBe(false);
    expect(fake.jobs.has(`datarestore-${r.id}`)).toBe(false);
  });

  it("restore Jobs outlive their restore by a day (ttlSecondsAfterFinished)", async () => {
    const { fake } = ctx;
    const { r } = await restoreUntil("restoring_data");
    expect(
      fake.jobs.get(`pgrestore-${r.id}`)!.job.spec!.ttlSecondsAfterFinished,
    ).toBe(86400);
    expect(
      fake.jobs.get(`datarestore-${r.id}`)!.job.spec!.ttlSecondsAfterFinished,
    ).toBe(86400);
  });
});

describe("handing back", () => {
  it("never starts an instance that was stopped (not held) when the restore began", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    fake.deployments.set("t-o1", app0);
    const r = await beginRestore(h.deps, await inst(), b, {
      purpose: "manual",
      thenVersion: null,
      who: SYSTEM_WHO,
    });
    await driveRestores(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("succeeded");
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });
});

describe("the app must stay stopped while /data is replaced", () => {
  it("does not start the /data Job while pods run: it scales to 0 again and waits", async () => {
    const { h, fake } = ctx;
    const { r } = await restoreUntil("restoring_db");
    fake.finish("pgrestore-");
    fake.deployments.set("t-o1", app1); // something scaled it up
    await pass(ctx);
    expect(fake.jobs.has(`datarestore-${r.id}`)).toBe(false);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_db");
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_data");
    expect(fake.jobs.has(`datarestore-${r.id}`)).toBe(true);
  });

  it("scales to 0 again on a /data pass that finds pods, and does not take the Job's end until none run", async () => {
    const { h, fake } = ctx;
    const { r } = await restoreUntil("restoring_data");
    fake.deployments.set("t-o1", app1);
    fake.finish("datarestore-");
    await pass(ctx);
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_data");
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("starting");
  });
});
