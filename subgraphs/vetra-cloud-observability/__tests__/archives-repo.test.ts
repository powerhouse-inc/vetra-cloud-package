import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { archiveKey, ArchivesRepo } from "../dumps/archive-repo.js";

let db: Kysely<ObservabilityDB>;
let repo: ArchivesRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db);
  await up(db); // idempotent
  repo = new ArchivesRepo(db);
});
afterEach(async () => db.destroy());

describe("ArchivesRepo", () => {
  it("keeps one in-flight archive per tenant, records its checksum, prunes a day after expiry", async () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const input = {
      documentId: "env-1",
      tenantId: "t-1",
      requestedBy: "VETRA",
      pvcName: "powerhouse-t-1-app-data",
      now,
    };
    const a = await repo.create(input);
    expect(a).toMatchObject({
      status: "PENDING",
      requestedBy: "vetra",
      pvcName: "powerhouse-t-1-app-data",
      requestedAt: now.toISOString(),
      expiresAt: "2026-12-12T10:00:00.000Z",
    });
    expect(await repo.inFlightForTenant("t-1")).toBe(true);
    expect(await repo.inFlightForTenant("t-2")).toBe(false);
    await expect(repo.create(input)).rejects.toThrow("ARCHIVE_IN_PROGRESS");
    await repo.markRunning(a.id, `dataarchive-${a.id}`, now);
    expect((await repo.listInFlight()).map((r) => r.status)).toEqual([
      "RUNNING",
    ]);
    await repo.markReady(
      a.id,
      archiveKey("t-1", a.id),
      1234,
      "f".repeat(64),
      now,
    );
    const ready = await repo.getById(a.id);
    expect(ready).toMatchObject({
      status: "READY",
      s3Key: `t-1/data/${a.id}.tar.zst`,
      sha256: "f".repeat(64),
      completedAt: now.toISOString(),
    });
    expect(Number(ready!.sizeBytes)).toBe(1234);
    expect(await repo.inFlightForTenant("t-1")).toBe(false);
    const b = await repo.create(input);
    await repo.markFailed(b.id, "x".repeat(600), now);
    expect((await repo.getById(b.id))!.errorMessage).toHaveLength(500);
    expect(await repo.pruneExpired(new Date("2026-12-13T09:00:00.000Z"))).toBe(
      0,
    );
    expect(await repo.pruneExpired(new Date("2026-12-13T10:00:01.000Z"))).toBe(
      2,
    );
  });
});
