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
  handlePodWatchEvent,
  reconcilePods,
  podToRow,
  type PodLike,
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
  it('returns CONNECT for component "connect"', () => {
    expect(classifyPodService("connect")).toBe("CONNECT");
  });

  it('returns SWITCHBOARD for component "switchboard"', () => {
    expect(classifyPodService("switchboard")).toBe("SWITCHBOARD");
  });

  it("returns OTHER for any other component value or null", () => {
    expect(classifyPodService("clint")).toBe("OTHER");
    expect(classifyPodService("fusion")).toBe("OTHER");
    expect(classifyPodService("registry")).toBe("OTHER");
    expect(classifyPodService(null)).toBe("OTHER");
    expect(classifyPodService(undefined)).toBe("OTHER");
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
    component: "connect",
    agent: null,
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

  it("persists component and agent labels for clint pods", async () => {
    // Pod name is exactly 63 chars and k8s dropped the dash before the hash
    // — the original regex-based matcher fails on this case. The label is
    // the source of truth.
    const clintPod = {
      id: "tenant-1/powerhouse-keen-lark-10-07b51285-clint-ph-pirate-cli-agent6ff6x",
      tenantId: "tenant-1",
      name: "powerhouse-keen-lark-10-07b51285-clint-ph-pirate-cli-agent6ff6x",
      service: "OTHER",
      component: "clint",
      agent: "ph-pirate-cli-agent",
      phase: "Running",
      ready: 1,
      restartCount: 0,
      updatedAt: "2026-05-05T00:00:00Z",
    };

    await upsertPod(db, clintPod);

    const rows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", clintPod.id)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBe("clint");
    expect(rows[0].agent).toBe("ph-pirate-cli-agent");
  });

  it("nulls component and agent when subsequent upsert lacks them", async () => {
    await upsertPod(db, {
      ...basePod,
      component: "clint",
      agent: "rupert",
    });

    await upsertPod(db, {
      ...basePod,
      component: null,
      agent: null,
    });

    const rows = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", basePod.id)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBeNull();
    expect(rows[0].agent).toBeNull();
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

// ---------------------------------------------------------------------------
// Pod lifecycle: watch DELETED + reconcile pruning
// ---------------------------------------------------------------------------

function pod(namespace: string, name: string, phase = "Running"): PodLike {
  return {
    metadata: {
      namespace,
      name,
      labels: { "app.kubernetes.io/component": "switchboard" },
    },
    status: { phase, containerStatuses: [{ ready: true, restartCount: 0 }] },
  };
}

async function seedPod(tenantId: string, name: string, phase = "FAILED") {
  await upsertPod(db, {
    id: `${tenantId}/${name}`,
    tenantId,
    name,
    service: "SWITCHBOARD",
    component: "switchboard",
    agent: null,
    phase,
    ready: 0,
    restartCount: 0,
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
}

async function podIds(): Promise<string[]> {
  const rows = await db
    .selectFrom("environment_pods")
    .select("id")
    .orderBy("id")
    .execute();
  return rows.map((r) => r.id);
}

describe("handlePodWatchEvent", () => {
  it("upserts on ADDED and MODIFIED", async () => {
    await handlePodWatchEvent(db, "ADDED", pod("t1", "sb-1", "Pending"));
    await handlePodWatchEvent(db, "MODIFIED", pod("t1", "sb-1", "Running"));
    const rows = await db.selectFrom("environment_pods").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("RUNNING");
  });

  it("deletes the row on DELETED instead of upserting it", async () => {
    await handlePodWatchEvent(db, "ADDED", pod("t1", "sb-1"));
    await handlePodWatchEvent(db, "ADDED", pod("t1", "sb-2"));
    await handlePodWatchEvent(db, "DELETED", pod("t1", "sb-1", "Failed"));
    expect(await podIds()).toEqual(["t1/sb-2"]);
  });

  it("DELETED for an unknown pod is a no-op", async () => {
    await seedPod("t1", "keep");
    await handlePodWatchEvent(db, "DELETED", pod("t1", "never-seen"));
    expect(await podIds()).toEqual(["t1/keep"]);
  });

  it("ignores BOOKMARK/ERROR events", async () => {
    await handlePodWatchEvent(db, "BOOKMARK", pod("t1", "sb-1"));
    await handlePodWatchEvent(db, "ERROR", { status: "Failure" });
    expect(await podIds()).toEqual([]);
  });
});

describe("reconcilePods", () => {
  it("upserts listed pods and deletes rows of gone pods in listed tenants", async () => {
    await seedPod("t1", "old-failed");
    await seedPod("t1", "sb-1", "PENDING");

    const res = await reconcilePods(db, async () => [
      pod("t1", "sb-1"),
      pod("t1", "sb-2"),
    ]);

    expect(await podIds()).toEqual(["t1/sb-1", "t1/sb-2"]);
    expect(res.stale.get("t1")).toBe(1);
    const sb1 = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", "t1/sb-1")
      .executeTakeFirstOrThrow();
    expect(sb1.phase).toBe("RUNNING");
  });

  it("never touches tenants absent from the listing", async () => {
    await seedPod("t1", "gone");
    await seedPod("t2", "unlisted");

    await reconcilePods(db, async () => [pod("t1", "sb-1")]);

    expect(await podIds()).toEqual(["t1/sb-1", "t2/unlisted"]);
  });

  it("prunes an extra (listed-but-empty) tenant, e.g. scaled to zero", async () => {
    await seedPod("t1", "gone");
    await seedPod("t2", "other");

    await reconcilePods(db, async () => [], { extraTenants: ["t1"] });

    expect(await podIds()).toEqual(["t2/other"]);
  });

  it("deletes nothing when the listing fails", async () => {
    await seedPod("t1", "a");
    await seedPod("t2", "b");

    await expect(
      reconcilePods(
        db,
        async () => {
          throw new Error("k8s API unavailable");
        },
        { extraTenants: ["t1", "t2"] },
      ),
    ).rejects.toThrow("k8s API unavailable");

    expect(await podIds()).toEqual(["t1/a", "t2/b"]);
  });

  it("keeps rows the watcher refreshed while the listing was in flight", async () => {
    await seedPod("t1", "stale");

    await reconcilePods(
      db,
      async () => {
        // Watcher sees a brand-new pod after the list snapshot was taken.
        await new Promise((r) => setTimeout(r, 5));
        await handlePodWatchEvent(db, "ADDED", pod("t1", "fresh"));
        return [];
      },
      { extraTenants: ["t1"] },
    );

    expect(await podIds()).toEqual(["t1/fresh"]);
  });

  it("dry run reports stale counts per tenant without writing", async () => {
    await seedPod("t1", "a");
    await seedPod("t1", "b");
    await seedPod("t2", "c");

    const res = await reconcilePods(
      db,
      async () => [pod("t1", "live"), pod("t2", "c")],
      { dryRun: true },
    );

    expect(Object.fromEntries(res.stale)).toEqual({ t1: 2 });
    expect(await podIds()).toEqual(["t1/a", "t1/b", "t2/c"]);
  });
});

describe("podToRow — image and waiting reason", () => {
  const pod = (
    over: Partial<NonNullable<PodLike["status"]>> = {},
  ): PodLike => ({
    metadata: {
      name: "app-0",
      namespace: "t1",
      labels: { "app.kubernetes.io/component": "app" },
    },
    spec: {
      containers: [
        { name: "app", image: "cr.vetra.io/acme/shop:1.5.0@sha256:aa" },
      ],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          ready: false,
          restartCount: 3,
          imageID: "cr.vetra.io/acme/shop@sha256:aa",
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
      ...over,
    },
  });

  it("records the spec image, the running imageID and why the container waits", () => {
    expect(podToRow(pod(), "2026-11-12T00:00:00.000Z")).toMatchObject({
      image: "cr.vetra.io/acme/shop:1.5.0@sha256:aa",
      imageId: "cr.vetra.io/acme/shop@sha256:aa",
      waitingReason: "CrashLoopBackOff",
      restartCount: 3,
      ready: 0,
    });
  });

  it("prefers the app container's reason, and a crash or pull over a container still being created", () => {
    const sidecar = (reason: string) => ({
      name: "proxy",
      state: { waiting: { reason } },
    });
    const app = (reason?: string) => ({
      name: "app",
      state: reason ? { waiting: { reason } } : {},
    });
    const reason = (cs: NonNullable<PodLike["status"]>["containerStatuses"]) =>
      podToRow(pod({ containerStatuses: cs }))!.waitingReason;
    expect(reason([sidecar("PodInitializing"), app("CrashLoopBackOff")])).toBe(
      "CrashLoopBackOff",
    );
    expect(reason([sidecar("ErrImagePull"), app("CreateContainerError")])).toBe(
      "CreateContainerError",
    );
    expect(
      reason([sidecar("ImagePullBackOff"), app("ContainerCreating")]),
    ).toBe("ImagePullBackOff");
    expect(reason([sidecar("ContainerCreating"), app()])).toBe(
      "ContainerCreating",
    );
    expect(reason([sidecar("ContainerCreating"), app("PodInitializing")])).toBe(
      "PodInitializing",
    );
  });

  it("leaves imageId null while the image is pulled (empty imageID)", () => {
    const row = podToRow(
      pod({
        containerStatuses: [
          {
            name: "app",
            imageID: "",
            state: { waiting: { reason: "ImagePullBackOff" } },
          },
        ],
      }),
    );
    expect(row).toMatchObject({
      imageId: null,
      waitingReason: "ImagePullBackOff",
    });
  });

  it("stores and updates the new columns", async () => {
    const row = podToRow(pod())!;
    await upsertPod(db, row);
    await upsertPod(db, {
      ...row,
      imageId: "cr.vetra.io/acme/shop@sha256:bb",
      waitingReason: null,
    });
    const stored = await db
      .selectFrom("environment_pods")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      imageId: "cr.vetra.io/acme/shop@sha256:bb",
      waitingReason: null,
      image: row.image,
    });
  });
});
