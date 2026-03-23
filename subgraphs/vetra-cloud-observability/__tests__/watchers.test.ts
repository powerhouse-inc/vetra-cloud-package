import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import {
  classifyPodService,
  upsertEnvironmentStatus,
  upsertPod,
  insertEvent,
  pruneEvents,
} from "../watchers.js";

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

// ---------------------------------------------------------------------------
// classifyPodService
// ---------------------------------------------------------------------------

describe("classifyPodService", () => {
  it('returns CONNECT for names starting with "connect"', () => {
    expect(classifyPodService("connect-xyz-abc")).toBe("CONNECT");
    expect(classifyPodService("connect")).toBe("CONNECT");
  });

  it('returns SWITCHBOARD for names starting with "switchboard"', () => {
    expect(classifyPodService("switchboard-xyz")).toBe("SWITCHBOARD");
    expect(classifyPodService("switchboard")).toBe("SWITCHBOARD");
  });

  it("returns OTHER for unrecognized names", () => {
    expect(classifyPodService("postgres-xyz")).toBe("OTHER");
    expect(classifyPodService("redis-pod")).toBe("OTHER");
    expect(classifyPodService("")).toBe("OTHER");
  });
});

// ---------------------------------------------------------------------------
// upsertEnvironmentStatus
// ---------------------------------------------------------------------------

describe("upsertEnvironmentStatus", () => {
  const baseRow = {
    tenantId: "tenant-1",
    argoSyncStatus: "Synced",
    argoHealthStatus: "Healthy",
    argoLastSyncedAt: "2024-01-01T00:00:00Z",
    argoMessage: null,
    configDriftDetected: 0,
    tlsCertValid: null,
    tlsCertExpiresAt: null,
    domainResolves: null,
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("inserts a new row", async () => {
    await upsertEnvironmentStatus(db, baseRow);

    const rows = await db
      .selectFrom("environment_status")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-1");
    expect(rows[0].argoSyncStatus).toBe("Synced");
    expect(rows[0].argoHealthStatus).toBe("Healthy");
  });

  it("updates existing row on conflict (tenantId)", async () => {
    await upsertEnvironmentStatus(db, baseRow);

    const updatedRow = {
      ...baseRow,
      argoSyncStatus: "OutOfSync",
      argoHealthStatus: "Degraded",
      updatedAt: "2024-06-01T00:00:00Z",
    };

    await upsertEnvironmentStatus(db, updatedRow);

    const rows = await db
      .selectFrom("environment_status")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].argoSyncStatus).toBe("OutOfSync");
    expect(rows[0].argoHealthStatus).toBe("Degraded");
    expect(rows[0].updatedAt).toBe("2024-06-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// upsertPod
// ---------------------------------------------------------------------------

describe("upsertPod", () => {
  const basePod = {
    id: "tenant-1/connect-pod-abc",
    tenantId: "tenant-1",
    name: "connect-pod-abc",
    service: "CONNECT",
    phase: "Running",
    ready: 1,
    restartCount: 0,
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("inserts a new pod", async () => {
    await upsertPod(db, basePod);

    const rows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", "tenant-1/connect-pod-abc")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("CONNECT");
    expect(rows[0].phase).toBe("Running");
    expect(rows[0].ready).toBe(1);
    expect(rows[0].restartCount).toBe(0);
  });

  it("updates pod on conflict (id)", async () => {
    await upsertPod(db, basePod);

    const updatedPod = {
      ...basePod,
      phase: "CrashLoopBackOff",
      ready: 0,
      restartCount: 5,
      updatedAt: "2024-06-01T00:00:00Z",
    };

    await upsertPod(db, updatedPod);

    const rows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", "tenant-1/connect-pod-abc")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("CrashLoopBackOff");
    expect(rows[0].ready).toBe(0);
    expect(rows[0].restartCount).toBe(5);
    expect(rows[0].updatedAt).toBe("2024-06-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// insertEvent
// ---------------------------------------------------------------------------

describe("insertEvent", () => {
  const baseEvent = {
    id: "event-uid-123",
    tenantId: "tenant-1",
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container",
    involvedObject: "Pod/connect-pod-abc",
    timestamp: "2024-01-01T00:00:00Z",
  };

  it("inserts a new event", async () => {
    await insertEvent(db, baseEvent);

    const rows = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("id", "=", "event-uid-123")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("Warning");
    expect(rows[0].reason).toBe("BackOff");
  });

  it("is idempotent — inserting the same UID twice results in 1 row", async () => {
    await insertEvent(db, baseEvent);
    await insertEvent(db, baseEvent);

    const rows = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("id", "=", "event-uid-123")
      .execute();

    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pruneEvents
// ---------------------------------------------------------------------------

describe("pruneEvents", () => {
  it("prunes events above keepCount, leaving exactly keepCount rows", async () => {
    const tenantId = "tenant-prune";

    // Insert 55 events with different timestamps
    for (let i = 0; i < 55; i++) {
      const ts = new Date(2024, 0, i + 1).toISOString();
      await insertEvent(db, {
        id: `event-uid-${i}`,
        tenantId,
        type: "Normal",
        reason: "Scheduled",
        message: `Event ${i}`,
        involvedObject: "Pod/some-pod",
        timestamp: ts,
      });
    }

    // Verify all 55 are present
    const before = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .execute();
    expect(before).toHaveLength(55);

    // Prune to 50
    await pruneEvents(db, tenantId, 50);

    const after = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .execute();
    expect(after).toHaveLength(50);
  });

  it("does not prune when count is below keepCount", async () => {
    const tenantId = "tenant-small";

    for (let i = 0; i < 10; i++) {
      const ts = new Date(2024, 0, i + 1).toISOString();
      await insertEvent(db, {
        id: `small-event-${i}`,
        tenantId,
        type: "Normal",
        reason: "Scheduled",
        message: `Event ${i}`,
        involvedObject: "Pod/some-pod",
        timestamp: ts,
      });
    }

    await pruneEvents(db, tenantId, 50);

    const rows = await db
      .selectFrom("environment_events")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .execute();
    expect(rows).toHaveLength(10);
  });
});
