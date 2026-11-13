import { PGlite } from "@electric-sql/pglite";
import type { V1Job } from "@kubernetes/client-node";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import { createDumpAndJob } from "../dumps/service.js";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db);
  repo = new DumpsRepo(db);
});
afterEach(async () => db.destroy());

const deps = (created: string[]) => ({
  repo,
  createJob: async (ns: string, j: V1Job) => {
    created.push(`${ns}/${j.metadata!.name}`);
    return j.metadata!.name!;
  },
  image: "cr.vetra.io/x/pgdump-uploader:1.0.0",
  bucket: "dumps",
  s3Endpoint: "https://s3.test",
  s3AccessKey: "AK",
  s3SecretKey: "SK",
});

describe("createDumpAndJob for instances (releases phase 3 slice 4)", () => {
  it("records the source and the caller's clock, one dump per tenant at a time", async () => {
    const created: string[] = [];
    const at = new Date("2026-10-02T12:00:00.000Z");
    const d = await createDumpAndJob(deps(created), {
      documentId: "env-1",
      tenantId: "t-1",
      requestedBy: "vetra",
      source: "PRE_UPDATE",
      now: at,
    });
    expect(d).toMatchObject({
      source: "PRE_UPDATE",
      requestedAt: at.toISOString(),
      expiresAt: "2026-11-01T12:00:00.000Z",
    });
    expect(created).toEqual([`t-1/pgdump-${d.id}`]);
    await expect(
      createDumpAndJob(deps(created), {
        documentId: "env-1",
        tenantId: "t-1",
        requestedBy: "vetra",
        source: "INSTANCE",
        now: at,
      }),
    ).rejects.toThrow("DUMP_IN_PROGRESS");
  });
});
