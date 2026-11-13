import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { ArchivesRepo } from "../dumps/archive-repo.js";
import { reconcileArchiveJob } from "../dumps/archive-watcher.js";

let db: Kysely<ObservabilityDB>;
let repo: ArchivesRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db);
  repo = new ArchivesRepo(db);
});
afterEach(async () => db.destroy());

const now = new Date("2026-11-12T10:00:00.000Z");
const make = () =>
  repo.create({
    documentId: "env-1",
    tenantId: "t-1",
    requestedBy: "vetra",
    pvcName: "p-app-data",
    now,
  });
const run = (
  id: string,
  o: {
    status: object;
    phase?: string | null;
    logs?: string;
    size?: number | null;
  },
) =>
  reconcileArchiveJob({
    repo,
    archiveId: id,
    jobName: `dataarchive-${id}`,
    jobStatus: o.status,
    podPhase: o.phase ?? null,
    now,
    headSize: async () => (o.size === undefined ? 42 : o.size),
    readPodLogs: async () => o.logs ?? "",
  });

describe("reconcileArchiveJob", () => {
  it("RUNNING, then READY with the checksum from the log and the object's size", async () => {
    const a = await make();
    await run(a.id, { status: { active: 1 }, phase: "Running" });
    expect((await repo.getById(a.id))!.status).toBe("RUNNING");
    await run(a.id, {
      status: {
        succeeded: 1,
        conditions: [{ type: "Complete", status: "True" }],
      },
      logs: `ARCHIVE_SHA256=${"c".repeat(64)}\n`,
    });
    const r = await repo.getById(a.id);
    expect(r).toMatchObject({
      status: "READY",
      sha256: "c".repeat(64),
      s3Key: `t-1/data/${a.id}.tar.zst`,
    });
    expect(Number(r!.sizeBytes)).toBe(42);
  });

  it("FAILED when the Job failed, finished without a checksum, or left no object", async () => {
    const a = await make();
    await run(a.id, { status: { failed: 1 }, logs: "s5cmd: access denied\n" });
    expect(await repo.getById(a.id)).toMatchObject({
      status: "FAILED",
      errorMessage: "s5cmd: access denied",
    });
    const b = await make();
    await run(b.id, { status: { succeeded: 1 }, logs: "done\n" });
    expect((await repo.getById(b.id))!.errorMessage).toMatch(
      /without a checksum/,
    );
    const c = await make();
    await run(c.id, {
      status: { succeeded: 1 },
      logs: `ARCHIVE_SHA256=${"c".repeat(64)}`,
      size: null,
    });
    expect((await repo.getById(c.id))!.errorMessage).toMatch(
      /not in the bucket/,
    );
  });
});
