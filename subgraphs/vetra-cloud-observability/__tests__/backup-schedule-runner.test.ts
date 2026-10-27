import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import {
  DEFAULT_SCHEDULE,
  runBackupScheduleTick,
  toBackupEnvSnapshot,
  type BackupEnvSnapshot,
  type RunnerDeps,
} from "../dumps/backup-schedule-runner.js";
import type { CreateDumpInput } from "../dumps/service.js";

const NOW = new Date("2026-10-27T02:00:00Z");
const HOUR = 3_600_000;

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;
let fire: ReturnType<typeof vi.fn<(i: CreateDumpInput) => Promise<unknown>>>;
let deps: RunnerDeps;

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  repo = new DumpsRepo(db);
  fire = vi.fn(async (input: CreateDumpInput) =>
    repo.create({ ...input, now: NOW }),
  );
  deps = { repo, fire: fire as never, deleteObject: async () => undefined, maxInFlight: 5 };
});
afterEach(async () => db.destroy());

const env = (tenantId: string, backupSchedule: BackupEnvSnapshot["backupSchedule"] = null): BackupEnvSnapshot => ({
  documentId: `doc-${tenantId}`,
  tenantId,
  backupSchedule,
});

async function pastScheduled(tenantId: string, at: Date) {
  const d = await repo.create({ documentId: "d", tenantId, requestedBy: "scheduler", now: at, source: "SCHEDULED" });
  await repo.markReady(d.id, `${tenantId}/${d.id}.dump`, 1, at);
  return d;
}

describe("runBackupScheduleTick", () => {
  it("treats a missing schedule as daily, keep 7, and fires a first dump", async () => {
    expect(DEFAULT_SCHEDULE).toEqual({ enabled: true, cadence: "DAILY", retention: 7 });
    const result = await runBackupScheduleTick([env("t1")], deps, NOW);
    expect(result.fired).toEqual(["doc-t1"]);
    expect(fire).toHaveBeenCalledWith({
      documentId: "doc-t1",
      tenantId: "t1",
      requestedBy: "scheduler",
      source: "SCHEDULED",
    });
  });

  it("skips a disabled schedule", async () => {
    const result = await runBackupScheduleTick(
      [env("t1", { enabled: false, cadence: "DAILY", retention: 7 })],
      deps,
      NOW,
    );
    expect(result.fired).toEqual([]);
  });

  it("fires only once the cadence has elapsed since the last scheduled dump", async () => {
    await pastScheduled("t1", new Date(NOW.getTime() - 23 * HOUR));
    await pastScheduled("t2", new Date(NOW.getTime() - 24 * HOUR));
    const result = await runBackupScheduleTick([env("t1"), env("t2")], deps, NOW);
    expect(result.fired).toEqual(["doc-t2"]);
  });

  it("honours HOURLY and WEEKLY cadences", async () => {
    await pastScheduled("h", new Date(NOW.getTime() - HOUR));
    await pastScheduled("w", new Date(NOW.getTime() - 6 * 24 * HOUR));
    const result = await runBackupScheduleTick(
      [
        env("h", { enabled: true, cadence: "HOURLY", retention: 3 }),
        env("w", { enabled: true, cadence: "WEEKLY", retention: 3 }),
      ],
      deps,
      NOW,
    );
    expect(result.fired).toEqual(["doc-h"]);
  });

  it("caps scheduled dumps in flight across the cluster", async () => {
    deps.maxInFlight = 2;
    await repo.create({ documentId: "d", tenantId: "busy", requestedBy: "scheduler", now: NOW, source: "SCHEDULED" });
    const result = await runBackupScheduleTick([env("a"), env("b"), env("c")], deps, NOW);
    expect(result.fired).toEqual(["doc-a"]);
  });

  it("skips a tenant with any dump in flight without counting it as an error", async () => {
    await repo.create({ documentId: "d", tenantId: "t1", requestedBy: "0xabc", now: NOW });
    const onError = vi.fn();
    const result = await runBackupScheduleTick([env("t1")], { ...deps, onError }, NOW);
    expect(result.fired).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("applies the schedule's retention to scheduled dumps", async () => {
    const oldest = await pastScheduled("t1", new Date(NOW.getTime() - 3 * HOUR));
    await pastScheduled("t1", new Date(NOW.getTime() - 2 * HOUR));
    const result = await runBackupScheduleTick(
      [env("t1", { enabled: true, cadence: "DAILY", retention: 1 })],
      deps,
      NOW,
    );
    expect(result.deleted).toEqual([oldest.id]);
  });

  it("keeps ticking other envs when one fails", async () => {
    fire.mockImplementationOnce(async () => {
      throw new Error("k8s down");
    });
    const onError = vi.fn();
    const result = await runBackupScheduleTick([env("a"), env("b")], { ...deps, onError }, NOW);
    expect(result.fired).toEqual(["doc-b"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("toBackupEnvSnapshot", () => {
  const row = {
    id: "doc-1",
    tenantId: "t1",
    status: "READY",
    appRole: null,
    services: JSON.stringify([{ type: "SWITCHBOARD", enabled: true }]),
    backupSchedule: null,
  };

  it("maps a ready env with a switchboard", () => {
    expect(toBackupEnvSnapshot(row)).toEqual({ documentId: "doc-1", tenantId: "t1", backupSchedule: null });
  });

  it("parses a stored schedule", () => {
    expect(
      toBackupEnvSnapshot({ ...row, backupSchedule: '{"enabled":false,"cadence":"WEEKLY","retention":2}' })
        ?.backupSchedule,
    ).toEqual({ enabled: false, cadence: "WEEKLY", retention: 2 });
  });

  it.each([
    ["stopped", { status: "STOPPED" }],
    ["no tenant", { tenantId: null }],
    ["preview app", { appRole: "PREVIEW" }],
    ["no switchboard", { services: JSON.stringify([{ type: "CONNECT", enabled: true }]) }],
    ["disabled switchboard", { services: JSON.stringify([{ type: "SWITCHBOARD", enabled: false }]) }],
    ["garbage services", { services: "not json" }],
  ])("skips %s", (_label, patch) => {
    expect(toBackupEnvSnapshot({ ...row, ...patch })).toBeNull();
  });

  it("falls back to the default when the stored schedule is unreadable", () => {
    expect(toBackupEnvSnapshot({ ...row, backupSchedule: "{" })?.backupSchedule).toBeNull();
  });
});
