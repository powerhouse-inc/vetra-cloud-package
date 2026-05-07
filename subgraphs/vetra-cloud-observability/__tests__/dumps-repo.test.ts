import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  repo = new DumpsRepo(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("DumpsRepo", () => {
  it("creates a PENDING dump and lists it", async () => {
    const created = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date("2026-05-07T10:00:00Z"),
    });
    expect(created.status).toBe("PENDING");
    expect(created.id).toMatch(/^[a-z0-9]{12}$/);
    expect(created.requestedBy).toBe("0xabc");
    expect(created.expiresAt).toBe("2026-05-08T10:00:00.000Z");

    const list = await repo.listByTenant("tenant-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("rejects a second in-flight dump for the same tenant", async () => {
    await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    await expect(
      repo.create({
        documentId: "doc-1",
        tenantId: "tenant-1",
        requestedBy: "0xabc",
        now: new Date(),
      }),
    ).rejects.toThrow("DUMP_IN_PROGRESS");
  });

  it("allows a new dump after the previous reaches a terminal state", async () => {
    const first = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    await repo.markFailed(first.id, "boom", new Date());

    // Should now be allowed
    const second = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    expect(second.status).toBe("PENDING");
  });

  it("transitions PENDING -> RUNNING -> READY", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    await repo.markRunning(d.id, "pgdump-xxx", new Date());
    await repo.markReady(
      d.id,
      "tenant-1/" + d.id + ".dump",
      12345,
      new Date(),
    );

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("READY");
    expect(Number(list[0].sizeBytes)).toBe(12345);
    expect(list[0].s3Key).toBe("tenant-1/" + d.id + ".dump");
  });

  it("transitions to FAILED with truncated error message", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    const longErr = "x".repeat(800);
    await repo.markFailed(d.id, longErr, new Date());

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("FAILED");
    expect(list[0].errorMessage?.length).toBe(500);
  });

  it("lowercases requestedBy at create time", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xABC",
      now: new Date(),
    });
    expect(d.requestedBy).toBe("0xabc");
  });

  it("listInFlight returns only PENDING + RUNNING rows", async () => {
    const a = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    await repo.markRunning(a.id, "pgdump-a", new Date());
    await repo.markReady(a.id, "tenant-1/a.dump", 100, new Date());

    const b = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });

    const inFlight = await repo.listInFlight();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].id).toBe(b.id);
  });

  it("prunes rows older than the cutoff", async () => {
    // Insert directly with an old timestamp to simulate stale rows.
    await db
      .insertInto("database_dumps")
      .values({
        id: "old-row",
        documentId: "doc-1",
        tenantId: "tenant-1",
        requestedBy: "0xabc",
        status: "READY",
        jobName: null,
        s3Key: "tenant-1/old.dump",
        sizeBytes: 1,
        errorMessage: null,
        requestedAt: "2026-04-01T00:00:00Z",
        startedAt: null,
        completedAt: "2026-04-01T01:00:00Z",
        expiresAt: "2026-04-02T00:00:00Z",
      })
      .execute();

    const removed = await repo.pruneOlderThan(new Date("2026-05-07T00:00:00Z"));
    expect(removed).toBeGreaterThanOrEqual(1);
    const list = await repo.listByTenant("tenant-1");
    expect(list).toHaveLength(0);
  });
});
