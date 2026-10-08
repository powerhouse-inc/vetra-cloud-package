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
      templates: structuredClone(TEMPLATES), terms: structuredClone(TERMS) },
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
  it("is stable regardless of object key order, and sensitive to array order and values", () => {
    const reordered = TERMS.map((t) => Object.fromEntries(Object.entries(t).reverse()));
    expect(licensingStateHash(TEMPLATES, reordered)).toBe(licensingStateHash(TEMPLATES, TERMS));
    expect(licensingStateHash(TEMPLATES, TERMS)).toMatch(/^[0-9a-f]{64}$/);
    expect(licensingStateHash(TEMPLATES, [{ ...TERMS[0], status: "RETIRED" }])).not.toBe(licensingStateHash(TEMPLATES, TERMS));
    expect(licensingStateHash([], [TERMS[0], { ...TERMS[0], id: "k2" }]))
      .not.toBe(licensingStateHash([], [{ ...TERMS[0], id: "k2" }, TERMS[0]]));
    // A document from before the licensing module hashes like an empty one.
    expect(licensingStateHash(undefined, undefined)).toBe(licensingStateHash([], []));
  });
});

describe("ledger integrity check", () => {
  it("treats an app with no ledger row as unverified, not tampered", async () => {
    const { reads } = world();
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: true });
  });

  it("is clean when the recorded hash matches", async () => {
    const { reads } = world();
    await recordLicensingState(db, "app-1", TEMPLATES, TERMS, "2026-10-08T00:00:00.000Z");
    const app = (await reads.app("app-1"))!;
    expect(app).toMatchObject({ tampered: false, unverified: false });
    expect(resolveKind(app, "free")).toMatchObject({ ok: true });
  });

  it("holds an app whose licensing state changed outside Vetra", async () => {
    const { reads, state, error } = world();
    await recordLicensingState(db, "app-1", TEMPLATES, TERMS, "t");
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

  it("is clean again after a system write through appendLicensingOps records the new state", async () => {
    const { reads, state, client } = world();
    await recordLicensingState(db, "app-1", TEMPLATES, TERMS, "t");
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
