import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { ArchivesRepo } from "../dumps/archive-repo.js";
import { watchJobsOnce } from "../dumps/job-watch.js";
import { DumpsRepo } from "../dumps/repo.js";

let db: Kysely<ObservabilityDB>;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db);
});
afterEach(async () => db.destroy());

describe("watchJobsOnce", () => {
  it("reconciles dumps and archives by their labels, and fails rows whose Job vanished", async () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const dumps = new DumpsRepo(db);
    const archives = new ArchivesRepo(db);
    const d = await dumps.create({
      documentId: "e",
      tenantId: "t-1",
      requestedBy: "vetra",
      now,
      source: "INSTANCE",
    });
    const a = await archives.create({
      documentId: "e",
      tenantId: "t-1",
      requestedBy: "vetra",
      pvcName: "p-app-data",
      now,
    });
    const gone = await archives.create({
      documentId: "e",
      tenantId: "t-2",
      requestedBy: "vetra",
      pvcName: "p-app-data",
      now,
    });
    await archives.setJobName(gone.id, `dataarchive-${gone.id}`);
    const done = {
      succeeded: 1,
      conditions: [{ type: "Complete", status: "True" }],
    };
    await watchJobsOnce({
      dumps,
      archives,
      now: () => now,
      headSize: async () => 7,
      k8s: {
        listManagedJobs: async () => [
          {
            namespace: "t-1",
            name: `pgdump-${d.id}`,
            dumpId: d.id,
            archiveId: null,
          },
          {
            namespace: "t-1",
            name: `dataarchive-${a.id}`,
            dumpId: null,
            archiveId: a.id,
          },
        ],
        readJobStatus: async () => done,
        readPodPhaseForJob: async () => "Succeeded",
        readPodLogsForJob: async () => `ARCHIVE_SHA256=${"b".repeat(64)}`,
      },
    });
    expect((await dumps.getById(d.id))!.status).toBe("READY");
    expect((await archives.getById(a.id))!.status).toBe("READY");
    expect(await archives.getById(gone.id)).toMatchObject({
      status: "FAILED",
      errorMessage: expect.stringMatching(/no longer exists/),
    });
  });

  it("fails PENDING rows that never got a Job after 10 minutes, and leaves younger ones", async () => {
    const t0 = new Date("2026-11-12T10:00:00.000Z");
    const dumps = new DumpsRepo(db);
    const archives = new ArchivesRepo(db);
    const oldDump = await dumps.create({ documentId: "e", tenantId: "t-1", requestedBy: "vetra", now: t0, source: "INSTANCE" });
    const oldArchive = await archives.create({ documentId: "e", tenantId: "t-1", requestedBy: "vetra", pvcName: "p", now: t0 });
    const fresh = await dumps.create({ documentId: "e", tenantId: "t-2", requestedBy: "vetra", now: new Date(t0.getTime() + 9 * 60_000), source: "INSTANCE" });
    const k8s = {
      listManagedJobs: async () => [],
      readJobStatus: async () => null,
      readPodPhaseForJob: async () => null,
      readPodLogsForJob: async () => "",
    };
    await watchJobsOnce({ dumps, archives, now: () => new Date(t0.getTime() + 11 * 60_000), headSize: async () => 1, k8s });
    expect((await dumps.getById(oldDump.id))!.status).toBe("FAILED");
    expect((await archives.getById(oldArchive.id))!.status).toBe("FAILED");
    expect((await dumps.getById(fresh.id))!.status).toBe("PENDING");
  });
});
