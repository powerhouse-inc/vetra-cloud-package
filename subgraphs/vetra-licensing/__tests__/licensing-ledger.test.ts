import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  createAppLicensingWriter,
  createLedgerLookup,
  licensingStateHash,
  recordLicensingState,
} from "../licensing-ledger.js";
import { APP_DOC_TYPE, createAppReads, resolveKind } from "../app-reads.js";
import { OperationRejectedError } from "../publisher-errors.js";

const TEMPLATES = [
  { id: "t-free", name: null, mode: "SHARED", sharedEnvironment: null, services: [], packages: [],
    size: null, baseDomain: null, packageRegistry: null },
];
const TERMS = [
  { id: "k1", kind: "free", label: null, templateId: "t-free", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
];
const ARTIFACTS = [
  {
    kind: "FUSION_IMAGE", name: "shop",
    versions: [
      { version: "1.0.0", reference: "cr.vetra.io/p/shop:1.0.0", commitSha: null, runId: null, publishedAt: "2026-10-01T00:00:00.000Z" },
      { version: "1.1.0", reference: "cr.vetra.io/p/shop:1.1.0", commitSha: null, runId: null, publishedAt: "2026-10-02T00:00:00.000Z" },
    ],
    channels: [{ channel: "LATEST", version: "1.1.0" }],
  },
];
const STATE = { templates: TEMPLATES, terms: TERMS, artifacts: ARTIFACTS };

let db: Kysely<VetraLicensingDB>;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
});
afterEach(async () => {
  await db.destroy();
});

/** One in-memory app document whose licensing state tests can change. */
function world() {
  const state: { global: Record<string, unknown> } = {
    global: { name: "App", slug: "app", status: "ACTIVE", productionEnvironmentId: "env-prod",
      templates: structuredClone(TEMPLATES), terms: structuredClone(TERMS),
      artifacts: structuredClone(ARTIFACTS) },
  };
  const doc = { header: { id: "app-1", documentType: APP_DOC_TYPE }, state };
  const client = {
    find: async () => ({ results: [doc] }),
    get: async () => structuredClone(doc),
    getIncomingRelationships: async () => ({ results: [] }),
  };
  const error = vi.fn();
  const reads = createAppReads(client, { ledger: createLedgerLookup(db), logger: { warn: vi.fn(), error } });
  return { state, client, reads, error };
}

describe("licensingStateHash", () => {
  const S = { templates: TEMPLATES, terms: TERMS, artifacts: ARTIFACTS };
  it("is stable regardless of object key order, and sensitive to array order and values", () => {
    const reordered = TERMS.map((t) => Object.fromEntries(Object.entries(t).reverse()));
    expect(licensingStateHash({ ...S, terms: reordered })).toBe(licensingStateHash(S));
    expect(licensingStateHash(S)).toMatch(/^[0-9a-f]{64}$/);
    expect(licensingStateHash({ ...S, terms: [{ ...TERMS[0], status: "RETIRED" }] })).not.toBe(licensingStateHash(S));
    expect(licensingStateHash({ terms: [TERMS[0], { ...TERMS[0], id: "k2" }] }))
      .not.toBe(licensingStateHash({ terms: [{ ...TERMS[0], id: "k2" }, TERMS[0]] }));
    // A document from before the licensing module hashes like an empty one.
    expect(licensingStateHash({})).toBe(licensingStateHash({ templates: [], terms: [], artifacts: [] }));
    expect(licensingStateHash(null)).toBe(licensingStateHash({}));
  });

  it("covers artifact versions and channel pointers, and ignores fields outside its scope", () => {
    const moved = structuredClone(ARTIFACTS);
    moved[0]!.channels[0]!.version = "1.0.0";
    expect(licensingStateHash({ ...S, artifacts: moved })).not.toBe(licensingStateHash(S));
    const repointed = structuredClone(ARTIFACTS);
    repointed[0]!.versions[0]!.reference = "attacker.io/evil:1.1.0";
    expect(licensingStateHash({ ...S, artifacts: repointed })).not.toBe(licensingStateHash(S));
    expect(licensingStateHash({ ...S, name: "Renamed" } as never)).toBe(licensingStateHash(S));
  });
});

describe("ledger integrity check", () => {
  it("treats an app with no ledger row as unverified, not tampered", async () => {
    const { reads } = world();
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: true });
  });

  it("is clean when the recorded hash matches", async () => {
    const { reads } = world();
    await recordLicensingState(db, "app-1", STATE, "2026-10-08T00:00:00.000Z");
    const app = (await reads.app("app-1"))!;
    expect(app).toMatchObject({ tampered: false, unverified: false });
    expect(resolveKind(app, "free")).toMatchObject({ ok: true });
  });

  it("holds an app whose licensing state changed outside Vetra", async () => {
    const { reads, state, error } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    // e.g. add parent -> write -> remove parent: no relationship left behind.
    (state.global.terms as { status: string }[])[0]!.status = "RETIRED";
    (state.global.templates as { sharedEnvironment: string | null }[])[0]!.sharedEnvironment = "attacker-env";
    const app = (await reads.app("app-1"))!;
    expect(app).toMatchObject({ tampered: true, tamperReason: "licensing state changed outside Vetra", unverified: false });
    expect(resolveKind(app, "free")).toStrictEqual({
      ok: false, reason: "app app-1 is tampered: licensing state changed outside Vetra",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("TAMPERED"));
  });

  it("holds an app whose artifact version or channel pointer changed outside Vetra", async () => {
    for (const change of [
      (a: typeof ARTIFACTS) => { a[0]!.channels[0]!.version = "1.0.0"; },
      (a: typeof ARTIFACTS) => { a[0]!.versions.push({ ...a[0]!.versions[1]!, version: "6.6.6", reference: "attacker.io/evil" }); },
    ]) {
      await db.deleteFrom("app_licensing_state").execute();
      const { reads, state } = world();
      await recordLicensingState(db, "app-1", STATE, "t");
      change(state.global.artifacts as typeof ARTIFACTS);
      expect(await reads.app("app-1")).toMatchObject({
        tampered: true, tamperReason: "licensing state changed outside Vetra",
      });
    }
  });

  it("applies a system write to an already-tampered app without recording it, so the app stays held", async () => {
    const { reads, state, client } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    (state.global.artifacts as typeof ARTIFACTS)[0]!.channels[0]!.version = "1.0.0"; // foreign
    const execute = vi.fn(async () => {
      (state.global.terms as { status: string }[])[0]!.status = "RETIRED";
    });
    const logger = { error: vi.fn() };
    const writer = createAppLicensingWriter({ docs: { execute }, get: client.get, db, now: () => "t2", logger });
    await writer.appendLicensingOps("app-1", []);
    expect(execute).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("changed outside Vetra"));
    expect(await reads.app("app-1")).toMatchObject({ tampered: true });
    const row = await db.selectFrom("app_licensing_state").selectAll().executeTakeFirstOrThrow();
    expect(row.updated_at).toBe("t");
  });

  it("is clean again after a system write through appendLicensingOps records the new state", async () => {
    const { reads, state, client } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    const writer = createAppLicensingWriter({
      docs: {
        execute: async () => {
          (state.global.terms as { status: string }[])[0]!.status = "RETIRED";
        },
      },
      get: client.get,
      db,
      now: () => "2026-10-09T00:00:00.000Z",
    });
    await writer.appendLicensingOps("app-1", [{ type: "RETIRE_TERM" } as never]);
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
    const row = await db.selectFrom("app_licensing_state").selectAll().executeTakeFirstOrThrow();
    expect(row.updated_at).toBe("2026-10-09T00:00:00.000Z");
  });

  it("records the state even when a batch is rejected part-way, then rethrows", async () => {
    const { reads, state, client } = world();
    const writer = createAppLicensingWriter({
      docs: {
        execute: async () => {
          (state.global.terms as { status: string }[])[0]!.status = "RETIRED"; // first action applied
          throw new OperationRejectedError("SET_TERM_STATUS rejected: nope");
        },
      },
      get: client.get,
      db,
      now: () => "t",
    });
    await expect(writer.appendLicensingOps("app-1", [])).rejects.toThrow("SET_TERM_STATUS rejected: nope");
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
  });

  it("reports the write failure, not the re-read failure, for a missing document", async () => {
    const writer = createAppLicensingWriter({
      docs: { execute: async () => { throw new Error("app app-x not found"); } },
      get: async () => { throw new Error("Document not found: app-x"); },
      db,
      now: () => "t",
    });
    await expect(writer.appendLicensingOps("app-x", [])).rejects.toThrow("app app-x not found");
    expect(await db.selectFrom("app_licensing_state").selectAll().execute()).toStrictEqual([]);
  });
});
