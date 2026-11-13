import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import {
  insertBackup,
  insertRestore,
  lastBackupOf,
  sweepableBackups,
  type InstanceBackupRow,
} from "../backups/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const backup = (
  id: string,
  over: Partial<InstanceBackupRow> = {},
): InstanceBackupRow => ({
  id,
  app_id: "app-1",
  instance_id: "i-1",
  environment_id: "env-1",
  tenant_id: "t-1",
  reason: "daily",
  version: "1.4.0",
  digest: null,
  dump_id: `d-${id}`,
  archive_id: `a-${id}`,
  status: "ready",
  error: null,
  size_bytes: 10,
  requested_by: "vetra",
  rollout_step_id: null,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  finished_at: null,
  expires_at: "2026-11-15T00:00:00.000Z",
  ...over,
});

describe("backups repo", () => {
  it("finds the newest backup of a reason, and sweeps expired and old failed backups but never one a restore uses", async () => {
    await insertBackup(
      h.db,
      backup("old", {
        created_at: "2026-10-01T00:00:00.000Z",
        expires_at: "2026-10-15T00:00:00.000Z",
      }),
    );
    await insertBackup(
      h.db,
      backup("used", {
        created_at: "2026-10-02T00:00:00.000Z",
        expires_at: "2026-10-16T00:00:00.000Z",
      }),
    );
    await insertBackup(
      h.db,
      backup("failed", {
        status: "failed",
        created_at: "2026-11-10T00:00:00.000Z",
      }),
    );
    await insertBackup(
      h.db,
      backup("pending", {
        status: "pending",
        expires_at: "2026-10-01T00:00:00.000Z",
      }),
    );
    await insertBackup(
      h.db,
      backup("fresh", {
        created_at: "2026-11-12T00:00:00.000Z",
        reason: "manual",
      }),
    );
    await insertRestore(h.db, {
      id: "r-1",
      app_id: "app-1",
      instance_id: "i-1",
      environment_id: "env-1",
      tenant_id: "t-1",
      backup_id: "used",
      safety_backup_id: null,
      purpose: "manual",
      then_version: null,
      data: true,
      status: "restoring_db",
      phase_started_at: "2026-11-12T00:00:00.000Z",
      db_job: null,
      data_job: null,
      replicas: null,
      target_set: false,
      was_held: false,
      error: null,
      held: false,
      requested_by: "vetra",
      rollout_step_id: null,
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
      finished_at: null,
    });
    expect((await lastBackupOf(h.db, "i-1", "daily"))?.id).toBe("failed"); // newest daily, whatever its status
    expect((await lastBackupOf(h.db, "i-1", "manual"))?.id).toBe("fresh");
    const sweep = await sweepableBackups(
      h.db,
      "2026-11-12T12:00:00.000Z",
      "2026-11-11T12:00:00.000Z",
      10,
    );
    expect(sweep.map((b) => b.id)).toEqual(["old", "failed"]);
    expect(sweep[0].size_bytes).toBe(10);
  });
});
