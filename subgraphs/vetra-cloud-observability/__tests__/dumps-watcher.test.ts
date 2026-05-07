import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import { reconcileJob } from "../dumps/watcher.js";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  repo = new DumpsRepo(db);
});
afterEach(async () => db.destroy());

describe("reconcileJob", () => {
  it("transitions PENDING -> RUNNING when pod is Running", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });

    await reconcileJob({
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: { active: 1, succeeded: 0, failed: 0 },
      podPhase: "Running",
      now: new Date(),
      headSize: async () => null,
      readPodLogs: async () => "",
    });

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("RUNNING");
    expect(list[0].startedAt).toBeTruthy();
  });

  it("transitions to READY on Job.Complete with size", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });

    await reconcileJob({
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: {
        active: 0,
        succeeded: 1,
        failed: 0,
        conditions: [{ type: "Complete", status: "True" }],
      },
      podPhase: "Succeeded",
      now: new Date(),
      headSize: async () => 12345,
      readPodLogs: async () => "",
    });

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("READY");
    expect(Number(list[0].sizeBytes)).toBe(12345);
    expect(list[0].s3Key).toBe(`tenant-1/${d.id}.dump`);
  });

  it("transitions to FAILED on Job.Failed with last log line", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });

    await reconcileJob({
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: {
        active: 0,
        succeeded: 0,
        failed: 1,
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: "BackoffLimitExceeded",
          },
        ],
      },
      podPhase: "Failed",
      now: new Date(),
      headSize: async () => null,
      readPodLogs: async () =>
        'starting\npg_dump: error: connection to server at "x" failed\n',
    });

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("FAILED");
    expect(list[0].errorMessage).toContain("pg_dump: error");
  });

  it("falls back to Job condition reason when logs are empty", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });

    await reconcileJob({
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: {
        active: 0,
        succeeded: 0,
        failed: 1,
        conditions: [
          { type: "Failed", status: "True", reason: "DeadlineExceeded" },
        ],
      },
      podPhase: "Failed",
      now: new Date(),
      headSize: async () => null,
      readPodLogs: async () => "",
    });

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("FAILED");
    expect(list[0].errorMessage).toBe("DeadlineExceeded");
  });

  it("is idempotent — repeated reconcile of READY is a no-op", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    const args = {
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: {
        active: 0,
        succeeded: 1,
        failed: 0,
        conditions: [{ type: "Complete" as const, status: "True" as const }],
      },
      podPhase: "Succeeded",
      now: new Date(),
      headSize: async () => 100,
      readPodLogs: async () => "",
    };
    await reconcileJob(args);
    // Change headSize to ensure second reconcile doesn't overwrite size
    args.headSize = async () => 999;
    await reconcileJob(args);

    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("READY");
    expect(Number(list[0].sizeBytes)).toBe(100);
  });

  it("does not transition when Job has no observable status (still pending)", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: "tenant-1",
      requestedBy: "0xabc",
      now: new Date(),
    });
    await reconcileJob({
      repo,
      dumpId: d.id,
      jobName: `pgdump-${d.id}`,
      jobStatus: { active: 0, succeeded: 0, failed: 0 },
      podPhase: "Pending",
      now: new Date(),
      headSize: async () => null,
      readPodLogs: async () => "",
    });
    const list = await repo.listByTenant("tenant-1");
    expect(list[0].status).toBe("PENDING");
  });

  it("returns silently when the dump row doesn't exist", async () => {
    await expect(
      reconcileJob({
        repo,
        dumpId: "ghost-id",
        jobName: "pgdump-ghost",
        jobStatus: { succeeded: 1 },
        podPhase: "Succeeded",
        now: new Date(),
        headSize: async () => 1,
        readPodLogs: async () => "",
      }),
    ).resolves.toBeUndefined();
  });
});
