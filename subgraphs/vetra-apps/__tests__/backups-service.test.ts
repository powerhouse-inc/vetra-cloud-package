import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER } from "./harness.js";
import {
  backupHarness,
  finishBackupJobs,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getBackup } from "../backups/repo.js";
import {
  advanceBackups,
  BACKUP_TIMEOUT_MS,
  BackupBusyError,
  BackupUnavailableError,
  startInstanceBackup,
} from "../backups/service.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("startInstanceBackup", () => {
  it("starts a dump and a colocated /data archive in the instance's namespace and records a pending backup", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    const b = await startInstanceBackup(h.deps, inst, {
      reason: "manual",
      requestedBy: OWNER,
    });
    expect(b).toMatchObject({
      instance_id: "o1",
      tenant_id: "t-o1",
      environment_id: "env-o1",
      reason: "manual",
      status: "pending",
      version: "1.4.0",
      requested_by: OWNER,
    });
    expect(Date.parse(b.expires_at) - Date.parse(b.created_at)).toBe(
      30 * 86_400_000,
    );
    const dump = await h.obsDb
      .selectFrom("database_dumps")
      .selectAll()
      .where("id", "=", b.dump_id!)
      .executeTakeFirstOrThrow();
    expect(dump).toMatchObject({
      tenantId: "t-o1",
      documentId: "env-o1",
      source: "INSTANCE",
    });
    expect(fake.jobs.get(`pgdump-${b.dump_id}`)?.ns).toBe("t-o1");
    const archive = fake.jobs.get(`dataarchive-${b.archive_id}`)!;
    expect(archive.ns).toBe("t-o1");
    expect(archive.job.spec!.template.spec!.affinity).toBeDefined();
    expect(archive.job.spec!.template.spec!.containers[0].image).toBe(
      "cr.vetra.io/x/pgdump-uploader:1.1.0",
    );
    await expect(
      startInstanceBackup(h.deps, inst, {
        reason: "daily",
        requestedBy: "vetra",
      }),
    ).rejects.toBeInstanceOf(BackupBusyError);
    const pre = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o2" }),
      {
        reason: "pre_update",
        requestedBy: "vetra",
        rolloutStepId: "step-1",
      },
    );
    expect(pre.rollout_step_id).toBe("step-1");
    expect(
      (
        await h.obsDb
          .selectFrom("database_dumps")
          .select("source")
          .where("id", "=", pre.dump_id!)
          .executeTakeFirstOrThrow()
      ).source,
    ).toBe("PRE_UPDATE");
  });

  it("says why it cannot back up, and starts nothing then", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    const go = (i = inst) =>
      startInstanceBackup(h.deps, i, { reason: "manual", requestedBy: OWNER });
    await expect(go({ ...inst, kind: "branch" })).rejects.toBeInstanceOf(
      BackupUnavailableError,
    );
    await expect(go({ ...inst, environment_id: null })).rejects.toThrow(
      /no environment/,
    );
    fake.pvcs.delete("t-o1");
    await expect(go()).rejects.toThrow(/no \/data volume/);
    h.deps.backups = null;
    await expect(go()).rejects.toThrow(/not configured/);
    expect(
      await h.obsDb.selectFrom("database_dumps").selectAll().execute(),
    ).toEqual([]);
  });
});

describe("advanceBackups", () => {
  it("ready when both Jobs are; failed and audited when one fails or it takes too long", async () => {
    const { h, appId, fake } = ctx;
    const a = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o1" }),
      { reason: "daily", requestedBy: "vetra" },
    );
    await advanceBackups(h.deps, appId);
    expect((await getBackup(h.db, a.id))!.status).toBe("pending");
    await finishBackupJobs(h, fake);
    await advanceBackups(h.deps, appId);
    expect(await getBackup(h.db, a.id)).toMatchObject({
      status: "ready",
      size_bytes: 150,
    });

    const b = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o2" }),
      { reason: "daily", requestedBy: "vetra" },
    );
    await finishBackupJobs(h, fake, "archive_failed");
    await advanceBackups(h.deps, appId);
    expect(await getBackup(h.db, b.id)).toMatchObject({
      status: "failed",
      error: "/data archive: tar: boom",
    });

    const c = await startInstanceBackup(
      h.deps,
      await planInstance(h, fake, appId, { id: "o3" }),
      { reason: "daily", requestedBy: "vetra" },
    );
    h.advance(BACKUP_TIMEOUT_MS + 1);
    await advanceBackups(h.deps, appId);
    expect((await getBackup(h.db, c.id))!.error).toMatch(
      /not finished after 75 minutes/,
    );

    const failed = (await listAudit(h.db, appId, { limit: 50 })).filter(
      (x) => x.action === "backup.failed",
    );
    expect(failed.map((x) => x.subject)).toEqual([
      "instance:o3",
      "instance:o2",
    ]);
  });
});
