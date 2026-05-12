import { describe, expect, it, vi } from "vitest";
import {
  CADENCE_MS,
  runBackupScheduleTick,
  type BackupEnvSnapshot,
  type RunnerRepo,
} from "../dumps/backup-schedule-runner.js";
import type { DatabaseDumps } from "../db/schema.js";

/** Helper: build a dump row stub. Only fields the runner reads matter. */
function dumpRow(overrides: Partial<DatabaseDumps>): DatabaseDumps {
  return {
    id: "row-" + Math.random().toString(36).slice(2, 10),
    documentId: "doc-1",
    tenantId: "tenant-1",
    requestedBy: "scheduler",
    status: "READY",
    jobName: null,
    s3Key: null,
    sizeBytes: null,
    errorMessage: null,
    requestedAt: "2026-05-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-05-02T00:00:00.000Z",
    source: "SCHEDULED",
    ...overrides,
  };
}

/** Helper: build a runner-shaped repo stub. */
function fakeRepo(opts: {
  lastByTenant?: Record<string, Date | null>;
  scheduledByTenant?: Record<string, DatabaseDumps[]>;
}): RunnerRepo & {
  deleteCalls: string[];
  lastCalls: string[];
  listCalls: string[];
} {
  const deleteCalls: string[] = [];
  const lastCalls: string[] = [];
  const listCalls: string[] = [];
  return {
    deleteCalls,
    lastCalls,
    listCalls,
    async lastScheduledRequestedAt(tenantId: string) {
      lastCalls.push(tenantId);
      return opts.lastByTenant?.[tenantId] ?? null;
    },
    async listScheduledByTenant(tenantId: string) {
      listCalls.push(tenantId);
      return opts.scheduledByTenant?.[tenantId] ?? [];
    },
    async deleteById(id: string) {
      deleteCalls.push(id);
    },
  };
}

describe("runBackupScheduleTick", () => {
  it("is a no-op when there are no envs", async () => {
    const fire = vi.fn();
    const repo = fakeRepo({});
    const result = await runBackupScheduleTick([], repo, fire, new Date());

    expect(result).toEqual({ considered: 0, fired: [], deleted: [] });
    expect(fire).not.toHaveBeenCalled();
  });

  it("does not fire when schedule is disabled", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: false, cadence: "DAILY", retention: 7 },
    };
    const fire = vi.fn();
    const repo = fakeRepo({});
    const result = await runBackupScheduleTick([env], repo, fire, new Date());

    expect(result.fired).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
    // Disabled envs are skipped entirely — no retention check either,
    // because pausing should be cheap.
    expect(repo.listCalls).toEqual([]);
  });

  it("does not fire when backupSchedule is null", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: null,
    };
    const fire = vi.fn();
    const repo = fakeRepo({});
    const result = await runBackupScheduleTick([env], repo, fire, new Date());

    expect(result.fired).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });

  it("fires when schedule is enabled and there is no prior SCHEDULED dump", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: true, cadence: "DAILY", retention: 7 },
    };
    const fire = vi.fn().mockResolvedValue(dumpRow({ id: "new-row" }));
    const repo = fakeRepo({ lastByTenant: { "tenant-1": null } });
    const result = await runBackupScheduleTick([env], repo, fire, new Date());

    expect(result.fired).toEqual(["doc-1"]);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "scheduler",
      source: "SCHEDULED",
    });
  });

  it("does not fire when lastRunAt is within the cadence window", async () => {
    const now = new Date("2026-05-12T12:00:00Z");
    // 30min ago — less than HOURLY cadence.
    const lastRun = new Date(now.getTime() - 30 * 60 * 1000);
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: true, cadence: "HOURLY", retention: 3 },
    };
    const fire = vi.fn();
    const repo = fakeRepo({ lastByTenant: { "tenant-1": lastRun } });

    const result = await runBackupScheduleTick([env], repo, fire, now);
    expect(result.fired).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });

  it("fires when lastRunAt is past the cadence", async () => {
    const now = new Date("2026-05-12T12:00:00Z");
    // 90min ago — past HOURLY cadence.
    const lastRun = new Date(now.getTime() - 90 * 60 * 1000);
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: true, cadence: "HOURLY", retention: 3 },
    };
    const fire = vi.fn().mockResolvedValue(dumpRow({}));
    const repo = fakeRepo({ lastByTenant: { "tenant-1": lastRun } });

    const result = await runBackupScheduleTick([env], repo, fire, now);
    expect(result.fired).toEqual(["doc-1"]);
  });

  it("enforces retention: deletes the oldest excess rows", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: true, cadence: "DAILY", retention: 3 },
    };
    // Five existing SCHEDULED dumps; retention=3 → expect 2 oldest
    // deletions. The list is oldest-first.
    const rows = [
      dumpRow({ id: "r1", requestedAt: "2026-05-01T00:00:00Z" }),
      dumpRow({ id: "r2", requestedAt: "2026-05-02T00:00:00Z" }),
      dumpRow({ id: "r3", requestedAt: "2026-05-03T00:00:00Z" }),
      dumpRow({ id: "r4", requestedAt: "2026-05-04T00:00:00Z" }),
      dumpRow({ id: "r5", requestedAt: "2026-05-05T00:00:00Z" }),
    ];
    const fire = vi.fn().mockResolvedValue(dumpRow({ id: "new-row" }));
    const repo = fakeRepo({
      lastByTenant: { "tenant-1": null },
      scheduledByTenant: { "tenant-1": rows },
    });

    const result = await runBackupScheduleTick(
      [env],
      repo,
      fire,
      new Date("2026-05-06T00:00:00Z"),
    );

    expect(result.fired).toEqual(["doc-1"]);
    // r1, r2 — the two oldest — get deleted.
    expect(repo.deleteCalls).toEqual(["r1", "r2"]);
    expect(result.deleted).toEqual(["r1", "r2"]);
  });

  it("retention=N with exactly N rows does not delete anything", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: { enabled: true, cadence: "DAILY", retention: 3 },
    };
    const rows = [
      dumpRow({ id: "r1" }),
      dumpRow({ id: "r2" }),
      dumpRow({ id: "r3" }),
    ];
    const fire = vi
      .fn()
      // Fire returns immediately — the list query is what the runner
      // uses to count, and the new row would already be in there in
      // production. The test stub keeps it static at 3 to verify the
      // no-op path.
      .mockResolvedValue(dumpRow({ id: "new-row" }));
    const repo = fakeRepo({
      lastByTenant: { "tenant-1": null },
      scheduledByTenant: { "tenant-1": rows },
    });

    const result = await runBackupScheduleTick(
      [env],
      repo,
      fire,
      new Date(),
    );

    expect(result.deleted).toEqual([]);
    expect(repo.deleteCalls).toEqual([]);
  });

  it("one env throwing does not abort the tick for other envs", async () => {
    const envs: BackupEnvSnapshot[] = [
      {
        documentId: "doc-bad",
        tenantId: "tenant-bad",
        backupSchedule: { enabled: true, cadence: "DAILY", retention: 7 },
      },
      {
        documentId: "doc-ok",
        tenantId: "tenant-ok",
        backupSchedule: { enabled: true, cadence: "DAILY", retention: 7 },
      },
    ];
    const fire = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("k8s 500");
      })
      .mockResolvedValueOnce(dumpRow({ id: "ok-row" }));
    const repo = fakeRepo({
      lastByTenant: { "tenant-bad": null, "tenant-ok": null },
    });
    const errors: Array<{ tenantId: string; msg: string }> = [];

    const result = await runBackupScheduleTick(
      envs,
      repo,
      fire,
      new Date(),
      (env, err) => {
        errors.push({
          tenantId: env.tenantId,
          msg: err instanceof Error ? err.message : String(err),
        });
      },
    );

    // tenant-bad failed; tenant-ok still fired.
    expect(result.fired).toEqual(["doc-ok"]);
    expect(errors).toEqual([{ tenantId: "tenant-bad", msg: "k8s 500" }]);
  });

  it("skips unknown cadence values defensively", async () => {
    const env: BackupEnvSnapshot = {
      documentId: "doc-1",
      tenantId: "tenant-1",
      backupSchedule: {
        enabled: true,
        cadence: "MONTHLY" /* not a valid cadence */,
        retention: 7,
      },
    };
    const fire = vi.fn();
    const repo = fakeRepo({});

    const result = await runBackupScheduleTick([env], repo, fire, new Date());
    expect(result.fired).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });

  it("cadence constants match the documented ms periods", () => {
    expect(CADENCE_MS.HOURLY).toBe(60 * 60 * 1000);
    expect(CADENCE_MS.DAILY).toBe(24 * 60 * 60 * 1000);
    expect(CADENCE_MS.WEEKLY).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
