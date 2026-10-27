import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { DumpSource, ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import { applyRetention, RETENTION } from "../dumps/retention.js";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  repo = new DumpsRepo(db);
});
afterEach(async () => db.destroy());

async function dump(source: DumpSource, day: number, ready = true) {
  const now = new Date(Date.UTC(2026, 4, day));
  const d = await repo.create({ documentId: "doc", tenantId: "t1", requestedBy: "x", now, source });
  if (ready) await repo.markReady(d.id, `t1/${d.id}.dump`, 1, now);
  else await repo.markFailed(d.id, "boom", now);
  return d;
}

describe("applyRetention", () => {
  it("keeps the newest N of one source and deletes S3 object + row for the rest", async () => {
    const d1 = await dump("SCHEDULED", 1);
    const d2 = await dump("SCHEDULED", 2);
    const d3 = await dump("SCHEDULED", 3);
    const d4 = await dump("SCHEDULED", 4);
    const manual = await dump("MANUAL", 1);
    const deleteObject = vi.fn(async (_key: string) => undefined);

    const deleted = await applyRetention(repo, deleteObject, "t1", "SCHEDULED", 2);

    expect(deleted).toEqual([d1.id, d2.id]);
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual([`t1/${d1.id}.dump`, `t1/${d2.id}.dump`]);
    expect(await repo.getById(d3.id)).not.toBeNull();
    expect(await repo.getById(d4.id)).not.toBeNull();
    expect(await repo.getById(manual.id)).not.toBeNull();
  });

  it("never deletes an in-flight dump", async () => {
    await dump("MANUAL", 2);
    // Oldest row, still in flight (requested earlier, e.g. a slow Job).
    const pending = await repo.create({
      documentId: "doc", tenantId: "t1", requestedBy: "x", now: new Date(Date.UTC(2026, 4, 1)), source: "MANUAL",
    });
    const deleted = await applyRetention(repo, vi.fn(async () => undefined), "t1", "MANUAL", 1);
    expect(deleted).toEqual([]);
    expect(await repo.getById(pending.id)).not.toBeNull();
  });

  it("still deletes the row when the S3 delete fails", async () => {
    const d1 = await dump("MANUAL", 1);
    await dump("MANUAL", 2);
    const deleteObject = vi.fn(async () => {
      throw new Error("NoSuchKey");
    });
    const deleted = await applyRetention(repo, deleteObject, "t1", "MANUAL", 1);
    expect(deleted).toEqual([d1.id]);
    expect(await repo.getById(d1.id)).toBeNull();
  });

  it("deletes FAILED rows (no S3 key) without calling S3", async () => {
    const failed = await dump("PRE_RESTORE", 1, false);
    await dump("PRE_RESTORE", 2);
    const deleteObject = vi.fn(async (_key: string) => undefined);
    expect(await applyRetention(repo, deleteObject, "t1", "PRE_RESTORE", 1)).toEqual([failed.id]);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("pins the spec's per-source limits", () => {
    expect(RETENTION).toEqual({ MANUAL: 5, SCHEDULED: 7, PRE_RESTORE: 3 });
  });
});
