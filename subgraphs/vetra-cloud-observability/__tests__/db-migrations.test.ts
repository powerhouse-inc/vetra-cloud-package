import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up, down } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";

let db: Kysely<ObservabilityDB>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("db migrations", () => {
  it("creates all three tables", async () => {
    // If tables don't exist these queries would throw
    const statusRows = await db
      .selectFrom("environment_status")
      .selectAll()
      .execute();
    const podRows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .execute();
    const eventRows = await db
      .selectFrom("environment_events")
      .selectAll()
      .execute();

    expect(statusRows).toEqual([]);
    expect(podRows).toEqual([]);
    expect(eventRows).toEqual([]);
  });

  it("inserts and selects environment_status", async () => {
    await db
      .insertInto("environment_status")
      .values({
        tenantId: "tenant-1",
        argoSyncStatus: "SYNCED",
        argoHealthStatus: "HEALTHY",
        argoLastSyncedAt: "2024-01-01T00:00:00Z",
        argoMessage: null,
        configDriftDetected: 0,
        tlsCertValid: 1,
        tlsCertExpiresAt: "2025-01-01T00:00:00Z",
        domainResolves: 1,
        updatedAt: "2024-01-01T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("environment_status")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-1");
    expect(rows[0].argoSyncStatus).toBe("SYNCED");
    expect(rows[0].configDriftDetected).toBe(0);
  });

  it("inserts and selects environment_pods", async () => {
    await db
      .insertInto("environment_pods")
      .values({
        id: "tenant-1/connect-pod-abc",
        tenantId: "tenant-1",
        name: "connect-pod-abc",
        service: "CONNECT",
        phase: "RUNNING",
        ready: 1,
        restartCount: 0,
        updatedAt: "2024-01-01T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tenant-1/connect-pod-abc");
    expect(rows[0].service).toBe("CONNECT");
    expect(rows[0].ready).toBe(1);
  });

  it("inserts and selects environment_events", async () => {
    await db
      .insertInto("environment_events")
      .values({
        id: "event-uid-123",
        tenantId: "tenant-1",
        type: "Warning",
        reason: "BackOff",
        message: "Back-off restarting failed container",
        involvedObject: "Pod/connect-pod-abc",
        timestamp: "2024-01-01T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("id", "=", "event-uid-123")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("Warning");
    expect(rows[0].reason).toBe("BackOff");
  });

  it("up is idempotent (can be called twice)", async () => {
    // Should not throw due to ifNotExists()
    await expect(up(db)).resolves.not.toThrow();
  });

  it("down drops all tables", async () => {
    await down(db);

    // After down, querying should throw
    await expect(
      db.selectFrom("environment_status").selectAll().execute(),
    ).rejects.toThrow();
  });
});
