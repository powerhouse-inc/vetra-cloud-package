import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import {
  createDumpResolvers,
  type DumpResolverDeps,
} from "../dumps/resolvers.js";

const TENANT = "tenant-1";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;
let createJob: ReturnType<typeof vi.fn>;
let deleteJob: ReturnType<typeof vi.fn>;
let presign: ReturnType<typeof vi.fn>;
let listRestoreJobs: ReturnType<typeof vi.fn>;
let deps: DumpResolverDeps;

function envDbStub(envOwner: string | null) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () =>
            envOwner === null
              ? undefined
              : { id: "doc-1", tenantId: TENANT, owner: envOwner },
        }),
      }),
    }),
  };
}

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  repo = new DumpsRepo(db);

  createJob = vi.fn(async () => "pgdump-abc");
  deleteJob = vi.fn(async () => undefined);
  presign = vi.fn(async () => "https://signed.example/dump");
  listRestoreJobs = vi.fn(async () => [] as Array<{ name: string }>);

  deps = {
    repo,
    envDb: envDbStub("0xAbC") as never,
    createJob,
    deleteJob,
    presign,
    listRestoreJobs,
    image: "img:1",
    bucket: "powerhouse-env-dumps",
    s3Endpoint: "https://s3",
    s3AccessKey: "TESTACCESS",
    s3SecretKey: "TESTSECRET",
  };
});
afterEach(async () => db.destroy());

describe("requestEnvironmentDump", () => {
  it("creates a PENDING dump as the owner", async () => {
    const resolvers = createDumpResolvers(deps);
    const dump = await resolvers.Mutation.requestEnvironmentDump(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(dump.status).toBe("PENDING");
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0][0]).toBe(TENANT);
  });

  it("rejects non-owner", async () => {
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.requestEnvironmentDump(
        null,
        { tenantId: TENANT },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated", async () => {
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.requestEnvironmentDump(
        null,
        { tenantId: TENANT },
        {},
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rejects when env doesn't exist", async () => {
    deps = { ...deps, envDb: envDbStub(null) as never };
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.requestEnvironmentDump(
        null,
        { tenantId: TENANT },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
  });

  it("marks the row FAILED and rethrows when Job creation fails", async () => {
    createJob.mockRejectedValueOnce(new Error("k8s exploded"));
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.requestEnvironmentDump(
        null,
        { tenantId: TENANT },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("k8s exploded");
    const list = await repo.listByTenant(TENANT);
    expect(list[0].status).toBe("FAILED");
    expect(list[0].errorMessage).toContain("k8s exploded");
  });
});

describe("environmentDumps query", () => {
  it("returns dumps with presigned URL when READY and not expired", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: new Date(),
    });
    await repo.markReady(d.id, `${TENANT}/${d.id}.dump`, 12345, new Date());

    const resolvers = createDumpResolvers(deps);
    const list = await resolvers.Query.environmentDumps(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("READY");
    expect(list[0].downloadUrl).toBe("https://signed.example/dump");
    expect(list[0].sizeBytes).toBe(12345);
    expect(presign).toHaveBeenCalledWith(`${TENANT}/${d.id}.dump`);
  });

  it("omits the URL for expired READY dumps", async () => {
    const past = new Date("2026-01-01T00:00:00Z");
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: past,
    });
    await repo.markReady(d.id, `${TENANT}/${d.id}.dump`, 12345, past);

    const resolvers = createDumpResolvers(deps);
    const list = await resolvers.Query.environmentDumps(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(list[0].downloadUrl).toBeNull();
    expect(presign).not.toHaveBeenCalled();
  });

  it("omits the URL for non-READY dumps", async () => {
    await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: new Date(),
    });
    const resolvers = createDumpResolvers(deps);
    const list = await resolvers.Query.environmentDumps(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(list[0].status).toBe("PENDING");
    expect(list[0].downloadUrl).toBeNull();
  });

  it("rejects non-owner", async () => {
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Query.environmentDumps(
        null,
        { tenantId: TENANT },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
  });
});

describe("cancelEnvironmentDump", () => {
  async function seed(jobName: string | null = "pgdump-x") {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: new Date(),
    });
    if (jobName) await repo.setJobName(d.id, jobName);
    return d;
  }

  it("deletes the Job and marks the row FAILED", async () => {
    const d = await seed("pgdump-x");
    const resolvers = createDumpResolvers(deps);

    const result = await resolvers.Mutation.cancelEnvironmentDump(
      null,
      { dumpId: d.id },
      { user: { address: "0xabc" } },
    );

    expect(deleteJob).toHaveBeenCalledWith(TENANT, "pgdump-x");
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toBe("Cancelled by user");
  });

  it("skips Job deletion when jobName is null (race window)", async () => {
    const d = await seed(null);
    const resolvers = createDumpResolvers(deps);

    const result = await resolvers.Mutation.cancelEnvironmentDump(
      null,
      { dumpId: d.id },
      { user: { address: "0xabc" } },
    );

    expect(deleteJob).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
  });

  it("returns terminal rows unchanged (no-op for READY/FAILED)", async () => {
    const d = await seed("pgdump-x");
    await repo.markReady(d.id, `${TENANT}/${d.id}.dump`, 100, new Date());
    const resolvers = createDumpResolvers(deps);

    const result = await resolvers.Mutation.cancelEnvironmentDump(
      null,
      { dumpId: d.id },
      { user: { address: "0xabc" } },
    );

    expect(deleteJob).not.toHaveBeenCalled();
    expect(result.status).toBe("READY");
  });

  it("rejects non-owner", async () => {
    const d = await seed();
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.cancelEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("throws DUMP_NOT_FOUND for unknown id", async () => {
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.cancelEnvironmentDump(
        null,
        { dumpId: "nope" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("DUMP_NOT_FOUND");
  });
});

describe("restoreEnvironmentDump", () => {
  async function seedReady() {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: new Date(),
    });
    await repo.markReady(d.id, `${TENANT}/${d.id}.dump`, 12345, new Date());
    return d;
  }

  it("creates a pgrestore Job in the tenant namespace as the owner", async () => {
    const d = await seedReady();
    const resolvers = createDumpResolvers(deps);

    const result = await resolvers.Mutation.restoreEnvironmentDump(
      null,
      { dumpId: d.id },
      { user: { address: "0xabc" } },
    );

    expect(result).toEqual({ ok: true, message: null });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0][0]).toBe(TENANT);
    const jobManifest = createJob.mock.calls[0][1];
    expect(jobManifest.metadata.name).toMatch(/^pgrestore-/);
    expect(jobManifest.metadata.labels["vetra.io/kind"]).toBe("restore");
  });

  it("rejects non-owner", async () => {
    const d = await seedReady();
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated", async () => {
    const d = await seedReady();
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        {},
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws DUMP_NOT_FOUND for unknown id", async () => {
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: "nope" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("DUMP_NOT_FOUND");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws DUMP_NOT_READY when status is PENDING", async () => {
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: new Date(),
    });
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("DUMP_NOT_READY");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws DUMP_EXPIRED when expiresAt is in the past", async () => {
    // Create the row in the past so its 24h-TTL expiresAt is already
    // behind us.
    const past = new Date("2026-01-01T00:00:00Z");
    const d = await repo.create({
      documentId: "doc-1",
      tenantId: TENANT,
      requestedBy: "0xabc",
      now: past,
    });
    await repo.markReady(d.id, `${TENANT}/${d.id}.dump`, 12345, past);
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("DUMP_EXPIRED");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws RESTORE_IN_PROGRESS when a restore Job already exists in the namespace", async () => {
    const d = await seedReady();
    listRestoreJobs.mockResolvedValueOnce([{ name: "pgrestore-xyz" }]);
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("RESTORE_IN_PROGRESS");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws ENV_NOT_FOUND when env stub returns null", async () => {
    const d = await seedReady();
    deps = { ...deps, envDb: envDbStub(null) as never };
    const resolvers = createDumpResolvers(deps);
    await expect(
      resolvers.Mutation.restoreEnvironmentDump(
        null,
        { dumpId: d.id },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
    expect(createJob).not.toHaveBeenCalled();
  });
});
