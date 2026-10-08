import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import type { Action } from "document-model";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  createAppLedger,
  createAppLicensingWriter,
  createAppLock,
  createLedgerLookup,
  ensureLedgerTables,
  lazyLedger,
  licensingStateHash,
  reactorLedgerSource,
  recordLicensingState,
  type AppLedger,
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

type Terms = { status: string }[];

/**
 * One in-memory app document whose licensing state tests can change. Every
 * change is an operation with an action id, as in the reactor.
 */
function world() {
  const state: { global: Record<string, unknown> } = {
    global: { name: "App", slug: "app", status: "ACTIVE", productionEnvironmentId: "env-prod",
      templates: structuredClone(TEMPLATES), terms: structuredClone(TERMS),
      artifacts: structuredClone(ARTIFACTS) },
  };
  const ops: string[] = ["init-1", "init-2"];
  const doc = { header: { id: "app-1", documentType: APP_DOC_TYPE, revision: { global: 2 } }, state };
  /** Applies one operation: `mutate` changes the state, `id` is its action id. */
  const apply = (id: string, mutate: () => void = () => {}) => {
    mutate();
    ops.push(id);
    doc.header.revision.global = ops.length;
  };
  const getOperations = vi.fn(
    async (_id: string, _view?: unknown, filter?: { sinceRevision?: number }) => ({
      results: ops.flatMap((id, index) =>
        index >= (filter?.sinceRevision ?? 0) ? [{ index, action: { id } }] : []),
    }),
  );
  const client = {
    find: async () => ({ results: [doc] }),
    get: async () => structuredClone(doc),
    getOperations,
    getIncomingRelationships: async () => ({ results: [] }),
  };
  const error = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn() };
  const ledger = createAppLedger({
    db, source: reactorLedgerSource(client), now: () => "2026-10-09T00:00:00.000Z", logger,
  });
  const reads = createAppReads(client, {
    ledger: createLedgerLookup(db), heal: ledger.heal, logger: { warn: vi.fn(), error },
  });
  /** A system write that applies `actions` (ids a.id), each retiring the first term. */
  const retire = (actions: Action[]) => {
    for (const a of actions) apply(a.id, () => { (state.global.terms as Terms)[0]!.status = "RETIRED"; });
  };
  const writer = (execute: (id: string, actions: Action[]) => Promise<void>, l: AppLedger = ledger) =>
    createAppLicensingWriter({ docs: { execute }, ledger: l });
  return { state, ops, apply, client, getOperations, reads, error, logger, ledger, retire, writer };
}

const act = (id: string) => ({ id, type: "SET_TERM_STATUS", input: {}, scope: "global" }) as unknown as Action;
const row = () => db.selectFrom("app_licensing_state").selectAll().executeTakeFirstOrThrow();
const intents = () => db.selectFrom("app_licensing_intent").selectAll().orderBy("created_at").execute();

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
    const { reads, apply, state, logger, writer } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    apply("foreign-1", () => { (state.global.artifacts as typeof ARTIFACTS)[0]!.channels[0]!.version = "1.0.0"; });
    const execute = vi.fn(async (_id: string, actions: Action[]) => {
      for (const a of actions) apply(a.id, () => { (state.global.terms as Terms)[0]!.status = "RETIRED"; });
    });
    await writer(execute).appendLicensingOps("app-1", [act("sys-1")]);
    expect(execute).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("changed outside Vetra before this system write"));
    expect(await reads.app("app-1")).toMatchObject({ tampered: true });
    expect((await row()).updated_at).toBe("t");
    expect(await intents()).toStrictEqual([]);
  });

  it("is clean again after a system write through appendLicensingOps records the new state", async () => {
    const { reads, retire, writer } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-1")]);
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
    expect((await row()).updated_at).toBe("2026-10-09T00:00:00.000Z");
    expect(await intents()).toMatchObject([
      { app_id: "app-1", base_hash: licensingStateHash(STATE), base_revision: 2, action_ids: '["sys-1"]',
        done_at: "2026-10-09T00:00:00.000Z" },
    ]);
  });

  it("records the state even when a batch is rejected part-way, then rethrows", async () => {
    const { reads, retire, writer } = world();
    const w = writer(async (_id, actions) => {
      retire(actions.slice(0, 1)); // first action applied
      throw new OperationRejectedError("SET_TERM_STATUS rejected: nope");
    });
    await expect(w.appendLicensingOps("app-1", [act("sys-1"), act("sys-2")])).rejects.toThrow("SET_TERM_STATUS rejected: nope");
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
  });

  it("reports the write failure, not the re-read failure, for a missing document", async () => {
    const source = {
      getDoc: async () => null,
      operationsSince: async () => [],
    };
    const ledger = createAppLedger({ db, source, now: () => "t" });
    const writer = createAppLicensingWriter({
      docs: { execute: async () => { throw new Error("app app-x not found"); } },
      ledger,
    });
    await expect(writer.appendLicensingOps("app-x", [])).rejects.toThrow("app app-x not found");
    expect(await db.selectFrom("app_licensing_state").selectAll().execute()).toStrictEqual([]);
  });
});

describe("serialised system writes", () => {
  for (const crossReplica of [false, true]) {
    it(`two concurrent writes to one app leave it clean and never overlap (advisory lock: ${crossReplica})`, async () => {
      const w = world();
      await recordLicensingState(db, "app-1", STATE, "t");
      const ledger = createAppLedger({
        db,
        source: reactorLedgerSource(w.client),
        now: () => "2026-10-09T00:00:00.000Z",
        lock: createAppLock(db, { crossReplica }),
        logger: w.logger,
      });
      let inFlight = 0;
      let maxInFlight = 0;
      // e.g. CI matrix jobs registering PACKAGE and FUSION_IMAGE at once.
      const register = (id: string) =>
        ledger.append("app-1", [act(id)], async (_i, actions) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          for (const a of actions) {
            w.apply(a.id, () => {
              (w.state.global.artifacts as typeof ARTIFACTS)[0]!.versions.push({
                ...ARTIFACTS[0]!.versions[0]!, version: a.id, reference: `r:${a.id}`,
              });
            });
          }
          inFlight -= 1;
        }, { seedUnrecorded: false });
      await Promise.all([register("ci-package"), register("ci-fusion")]);
      expect(maxInFlight).toBe(1);
      expect(await w.reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
      expect(w.logger.error).not.toHaveBeenCalled();
      expect(w.logger.warn).not.toHaveBeenCalled(); // clean without healing
      expect((await intents()).map((i) => i.done_at)).toStrictEqual([
        "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z",
      ]);
    });
  }
});

describe("intent journal", () => {
  it("a write applied but not recorded is healed by the next read", async () => {
    const { reads, retire, writer, getOperations, logger, error } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    getOperations.mockRejectedValueOnce(new Error("db down"));
    // The record failure is logged, not thrown: the write itself succeeded.
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-1")]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("intent journal"));
    expect((await row()).state_hash).toBe(licensingStateHash(STATE));
    expect(await intents()).toMatchObject([{ done_at: null }]);

    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
    expect(error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("intent journal"));
    expect(await intents()).toMatchObject([{ done_at: "2026-10-09T00:00:00.000Z" }]);
  });

  it("a write applied but not recorded is healed by the next write", async () => {
    const { reads, retire, apply, state, writer, getOperations, logger } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    getOperations.mockRejectedValueOnce(new Error("db down"));
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-1")]);
    await writer(async (_id, actions) => {
      for (const a of actions) apply(a.id, () => { (state.global.templates as { size: string | null }[])[0]!.size = "L"; });
    }).appendLicensingOps("app-1", [act("sys-2")]);
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("changed outside Vetra"));
    expect(await reads.app("app-1")).toMatchObject({ tampered: false, unverified: false });
    expect((await intents()).map((i) => i.done_at)).toStrictEqual([
      "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z",
    ]);
  });

  it("a foreign operation after an unrecorded system write is not laundered", async () => {
    const { reads, retire, apply, state, writer, getOperations, logger } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    getOperations.mockRejectedValueOnce(new Error("db down"));
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-1")]);
    apply("foreign-1", () => { (state.global.artifacts as typeof ARTIFACTS)[0]!.channels[0]!.version = "1.0.0"; });

    expect(await reads.app("app-1")).toMatchObject({ tampered: true });
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-2")]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("changed outside Vetra before this system write"));
    expect(await reads.app("app-1")).toMatchObject({ tampered: true });
    expect((await row()).state_hash).toBe(licensingStateHash(STATE));
  });

  it("a foreign operation landing during a system write is not recorded", async () => {
    const { reads, retire, apply, state, writer, logger } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    await writer(async (_id, actions) => {
      apply("foreign-1", () => { (state.global.artifacts as typeof ARTIFACTS)[0]!.channels[0]!.version = "1.0.0"; });
      retire(actions);
    }).appendLicensingOps("app-1", [act("sys-1")]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("during this system write"));
    expect(await reads.app("app-1")).toMatchObject({ tampered: true });
  });

  it("does not execute when the intent cannot be journalled", async () => {
    const { writer } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    await db.schema.dropTable("app_licensing_intent").execute();
    const execute = vi.fn(async () => undefined);
    await expect(writer(execute).appendLicensingOps("app-1", [act("sys-1")])).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("prunes completed intents older than 7 days", async () => {
    const { retire, writer } = world();
    await recordLicensingState(db, "app-1", STATE, "t");
    const old = { app_id: "app-0", base_hash: "h", base_revision: 0, action_ids: "[]", created_at: "t" };
    await db.insertInto("app_licensing_intent").values([
      { ...old, id: "old-done", done_at: "2026-10-01T00:00:00.000Z" },
      { ...old, id: "recent-done", done_at: "2026-10-03T00:00:00.000Z" },
      { ...old, id: "old-pending", done_at: null },
    ]).execute();
    await writer(async (_id, actions) => retire(actions)).appendLicensingOps("app-1", [act("sys-1")]);
    expect((await intents()).map((i) => i.id).sort()).toEqual(
      expect.arrayContaining(["recent-done", "old-pending"]),
    );
    expect((await intents()).map((i) => i.id)).not.toContain("old-done");
  });
});

describe("ledger setup", () => {
  /** A Kysely stand-in whose every DDL statement fails with `code`. */
  const failingDb = (code: string) => {
    const chain: unknown = new Proxy(() => {}, {
      get: (_t, k) => (k === "execute" ? () => Promise.reject(Object.assign(new Error(code), { code })) : () => chain),
    });
    return { schema: chain } as unknown as Kysely<any>;
  };

  it("tolerates a concurrent CREATE ... IF NOT EXISTS (23505, 42P07), not other failures", async () => {
    await expect(ensureLedgerTables(failingDb("23505"))).resolves.toBeUndefined();
    await expect(ensureLedgerTables(failingDb("42P07"))).resolves.toBeUndefined();
    await expect(ensureLedgerTables(failingDb("42501"))).rejects.toThrow("42501");
    await expect(ensureLedgerTables(db as Kysely<any>)).resolves.toBeUndefined();
  });

  it("lazyLedger retries a failed initialisation and then caches", async () => {
    const ledger = {} as AppLedger;
    const init = vi.fn<() => Promise<AppLedger>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(ledger);
    const get = lazyLedger(init);
    await expect(get()).rejects.toThrow("db down");
    await expect(get()).resolves.toBe(ledger);
    await expect(get()).resolves.toBe(ledger);
    expect(init).toHaveBeenCalledTimes(2);
  });
});
