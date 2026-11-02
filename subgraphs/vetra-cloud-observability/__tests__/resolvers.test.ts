import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { createResolvers, type ResolverConfig } from "../resolvers.js";

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;
let resolvers: ReturnType<typeof createResolvers>;

const PROMETHEUS_URL = "http://prometheus.test";
const LOKI_URL = "http://loki.test";

const OWNER = "0xdef";
/** A signed-in caller who owns the seeded environments. */
const ownerCtx = { user: { address: OWNER } };

async function seedEnv(tenantId: string, owner: string | null): Promise<void> {
  await envDb
    .insertInto("environments")
    .values({ id: `doc-${tenantId}`, tenantId, owner })
    .execute();
}

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);

  envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await envDb.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("tenantId", "varchar(255)")
    .addColumn("owner", "varchar(255)")
    .addColumn("ownerOrgId", "varchar(255)")
    .addColumn("appId", "varchar(255)")
    .execute();
  await seedEnv("tenant-1", OWNER);
  await seedEnv("unknown-tenant", OWNER);

  resolvers = createResolvers(db, {
    prometheusUrl: PROMETHEUS_URL,
    lokiUrl: LOKI_URL,
    envDb,
    dispatch: (async () => {}) as ResolverConfig["dispatch"],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await envDb.destroy();
});

// Use a getter so `query` always refers to the current resolvers instance set by beforeEach
const getQuery = () => resolvers.Query;

describe("resolvers", () => {
  describe("observability access", () => {
    const stubs = {
      environmentStatus: () => getQuery().environmentStatus,
      environmentPods: () => getQuery().environmentPods,
      environmentEvents: () => getQuery().environmentEvents,
    };
    const names = Object.keys(stubs) as (keyof typeof stubs)[];

    afterEach(() => {
      delete process.env.ADMINS;
    });

    it("refuses an anonymous caller", async () => {
      for (const name of names) {
        await expect(stubs[name]()(undefined, { tenantId: "tenant-1" }, {})).rejects.toThrow(
          "UNAUTHENTICATED",
        );
      }
    });

    it("refuses a signed-in stranger", async () => {
      for (const name of names) {
        await expect(
          stubs[name]()(undefined, { tenantId: "tenant-1" }, { user: { address: "0xabc" } }),
        ).rejects.toThrow("FORBIDDEN");
      }
    });

    it("refuses an unknown tenant", async () => {
      for (const name of names) {
        await expect(
          stubs[name]()(undefined, { tenantId: "no-such" }, ownerCtx),
        ).rejects.toThrow("ENV_NOT_FOUND");
      }
    });

    it("serves the owner", async () => {
      await db
        .insertInto("environment_pods")
        .values({
          id: "tenant-1/p",
          tenantId: "tenant-1",
          name: "p",
          service: "CONNECT",
          phase: "Running",
          ready: 1,
          restartCount: 0,
          updatedAt: "2024-01-01T00:00:00Z",
        })
        .execute();
      const pods = await getQuery().environmentPods(undefined, { tenantId: "tenant-1" }, ownerCtx);
      expect(pods).toHaveLength(1);
      expect(
        await getQuery().environmentStatus(undefined, { tenantId: "tenant-1" }, ownerCtx),
      ).toBeNull();
      expect(
        await getQuery().environmentEvents(undefined, { tenantId: "tenant-1" }, ownerCtx),
      ).toEqual([]);
    });

    it("serves an admin", async () => {
      process.env.ADMINS = "0xAdmin";
      const ctx = { user: { address: "0xadmin" } };
      expect(await getQuery().environmentPods(undefined, { tenantId: "tenant-1" }, ctx)).toEqual(
        [],
      );
      expect(
        await getQuery().environmentEvents(undefined, { tenantId: "tenant-1" }, ctx),
      ).toEqual([]);
    });

    it("refuses an unowned environment to its future holder", async () => {
      await seedEnv("unowned", null);
      for (const name of names) {
        await expect(
          stubs[name]()(undefined, { tenantId: "unowned" }, { user: { address: "0xabc" } }),
        ).rejects.toThrow("FORBIDDEN");
      }
    });
  });

  describe("environmentStatus", () => {
    it("returns null for unknown tenant", async () => {
      const result = await getQuery().environmentStatus(undefined, {
        tenantId: "unknown-tenant",
      }, ownerCtx);

      expect(result).toBeNull();
    });

    it("returns status with boolean conversion", async () => {
      await db
        .insertInto("environment_status")
        .values({
          tenantId: "tenant-1",
          argoSyncStatus: "SYNCED",
          argoHealthStatus: "HEALTHY",
          argoLastSyncedAt: "2024-01-01T00:00:00Z",
          argoMessage: null,
          configDriftDetected: 1,
          tlsCertValid: null,
          tlsCertExpiresAt: null,
          domainResolves: 0,
          updatedAt: "2024-01-01T00:00:00Z",
        })
        .execute();

      const result = await getQuery().environmentStatus(undefined, {
        tenantId: "tenant-1",
      }, ownerCtx);

      expect(result).not.toBeNull();
      expect(result.tenantId).toBe("tenant-1");
      expect(result.configDriftDetected).toBe(true);
      expect(result.tlsCertValid).toBeNull();
      expect(result.domainResolves).toBe(false);
    });
  });

  describe("environmentPods", () => {
    it("returns empty array for unknown tenant", async () => {
      const result = await getQuery().environmentPods(undefined, {
        tenantId: "unknown-tenant",
      }, ownerCtx);

      expect(result).toEqual([]);
    });

    it("returns pods with ready boolean conversion and service OTHER → null", async () => {
      await db
        .insertInto("environment_pods")
        .values([
          {
            id: "tenant-1/connect-pod-abc",
            tenantId: "tenant-1",
            name: "connect-pod-abc",
            service: "CONNECT",
            phase: "Running",
            ready: 1,
            restartCount: 0,
            updatedAt: "2024-01-01T00:00:00Z",
          },
          {
            id: "tenant-1/other-pod-xyz",
            tenantId: "tenant-1",
            name: "other-pod-xyz",
            service: "OTHER",
            phase: "Running",
            ready: 0,
            restartCount: 2,
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ])
        .execute();

      const result = await getQuery().environmentPods(undefined, {
        tenantId: "tenant-1",
      }, ownerCtx);

      expect(result).toHaveLength(2);

      const connectPod = result.find((p: any) => p.name === "connect-pod-abc");
      expect(connectPod).toBeDefined();
      expect(connectPod.ready).toBe(true);
      expect(connectPod.service).toBe("CONNECT");

      const otherPod = result.find((p: any) => p.name === "other-pod-xyz");
      expect(otherPod).toBeDefined();
      expect(otherPod.ready).toBe(false);
      expect(otherPod.service).toBeNull();
    });
  });

  describe("environmentEvents", () => {
    it("returns events ordered by timestamp DESC", async () => {
      await db
        .insertInto("environment_events")
        .values([
          {
            id: "event-1",
            tenantId: "tenant-1",
            type: "Normal",
            reason: "Scheduled",
            message: "Scheduled successfully",
            involvedObject: "Pod/connect-pod-abc",
            timestamp: "2024-01-01T00:00:00Z",
          },
          {
            id: "event-2",
            tenantId: "tenant-1",
            type: "Warning",
            reason: "BackOff",
            message: "Back-off restarting failed container",
            involvedObject: "Pod/connect-pod-abc",
            timestamp: "2024-01-03T00:00:00Z",
          },
          {
            id: "event-3",
            tenantId: "tenant-1",
            type: "Normal",
            reason: "Pulling",
            message: "Pulling image",
            involvedObject: "Pod/connect-pod-abc",
            timestamp: "2024-01-02T00:00:00Z",
          },
        ])
        .execute();

      const result = await getQuery().environmentEvents(undefined, {
        tenantId: "tenant-1",
      }, ownerCtx);

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("event-2");
      expect(result[1].id).toBe("event-3");
      expect(result[2].id).toBe("event-1");
    });

    it("respects limit parameter", async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        id: `event-${i}`,
        tenantId: "tenant-1",
        type: "Normal",
        reason: "Scheduled",
        message: `Message ${i}`,
        involvedObject: "Pod/connect-pod-abc",
        timestamp: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }));

      await db.insertInto("environment_events").values(events).execute();

      const result = await getQuery().environmentEvents(undefined, {
        tenantId: "tenant-1",
        limit: 3,
      }, ownerCtx);

      expect(result).toHaveLength(3);
    });
  });

  describe("cpuUsage", () => {
    it("delegates to Prometheus and returns series", async () => {
      const mockResponse = {
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { pod: "connect-pod-abc" },
              values: [
                [1700000000, "0.05"],
                [1700000060, "0.07"],
              ],
            },
          ],
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockResponse,
        }),
      );

      const result = await getQuery().cpuUsage(undefined, {
        tenantId: "tenant-1",
        range: "FIVE_MIN",
      });

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("connect-pod-abc");
      expect(result[0].datapoints).toHaveLength(2);
      expect(result[0].datapoints[0].value).toBe(0.05);

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledOnce();
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain(PROMETHEUS_URL);
      expect(calledUrl).toContain("api/v1/query_range");
      expect(calledUrl).toContain("tenant-1");
    });
  });

  describe("logs", () => {
    it("delegates to Loki and returns entries", async () => {
      const nowNs = String(Date.now() * 1e6);
      const mockResponse = {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { namespace: "tenant-1" },
              values: [
                [nowNs, "log line one"],
                [String(BigInt(nowNs) + 1000n), "log line two"],
              ],
            },
          ],
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockResponse,
        }),
      );

      const result = await getQuery().logs(undefined, {
        tenantId: "tenant-1",
        service: null,
        since: "FIVE_MIN",
        limit: 50,
      });

      expect(result).toHaveLength(2);
      expect(result[0].line).toBe("log line one");
      expect(result[1].line).toBe("log line two");

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledOnce();
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain(LOKI_URL);
      expect(calledUrl).toContain("loki/api/v1/query_range");
      expect(calledUrl).toContain("tenant-1");
    });
  });

  // When the host omits dumpDeps (S3 creds missing) the schema's
  // non-nullable environmentDumps must still resolve cleanly so the
  // GraphQL layer doesn't raise "Cannot return null for non-nullable
  // field". Mutation calls instead surface a clear error code.
  describe("dumps fallback (no dumpDeps)", () => {
    it("environmentDumps returns an empty list", async () => {
      const list = await getQuery().environmentDumps(
        undefined,
        { tenantId: "tenant-1" },
        { user: { address: "0xabc" } } as never,
      );
      expect(list).toEqual([]);
    });

    it("requestEnvironmentDump throws DUMPS_NOT_CONFIGURED", async () => {
      await expect(
        resolvers.Mutation.requestEnvironmentDump(
          undefined,
          { tenantId: "tenant-1" },
          { user: { address: "0xabc" } } as never,
        ),
      ).rejects.toThrow("DUMPS_NOT_CONFIGURED");
    });
  });
});
