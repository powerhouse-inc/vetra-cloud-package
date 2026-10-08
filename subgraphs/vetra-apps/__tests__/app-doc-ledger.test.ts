import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { Action, PHDocument } from "document-model";
import {
  reducer,
  setArtifactChannel,
  recordArtifactVersion,
} from "../../../document-models/vetra-app/v1/index.js";
import { up as licensingUp } from "../../vetra-licensing/db/migrations.js";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import {
  createAppLedger,
  createLedgerLookup,
  ensureLedgerTables,
  lazyLedger,
  reactorLedgerSource,
  type AppLedger,
} from "../../vetra-licensing/licensing-ledger.js";
import { createAppReads } from "../../vetra-licensing/app-reads.js";
import { createReactorAppDocStore } from "../app-doc-store.js";
import { backfillAppDocuments } from "../app-document.js";
import { ciRecordArtifact } from "../service.js";
import {
  ciIdentity,
  claim,
  makeHarness,
  seedActiveApp,
  type Harness,
} from "./harness.js";

/** An in-memory reactor that runs the real vetra-app reducer. */
function memReactor() {
  const docs = new Map<string, PHDocument>();
  const notFound = (id: string) => new Error(`Document not found: ${id}`);
  return {
    docs,
    async create(doc: unknown) {
      const d = doc as PHDocument;
      // The reactor stamps the protocol version a presigned header lacks.
      d.header.protocolVersions ??= { "base-reducer": 2 };
      docs.set(d.header.id, d);
    },
    async get(id: string) {
      const d = docs.get(id);
      if (!d) throw notFound(id);
      return structuredClone(d);
    },
    async execute(id: string, _branch: string, actions: Action[]) {
      let d = docs.get(id);
      if (!d) throw notFound(id);
      for (const a of actions) d = reducer(d as never, a as never) as PHDocument;
      docs.set(id, d);
    },
    async getOperations(
      id: string,
      _view?: unknown,
      filter?: { sinceRevision?: number },
    ) {
      const ops = docs.get(id)?.operations.global ?? [];
      return {
        results: ops.filter((op) => op.index >= (filter?.sinceRevision ?? 0)),
      };
    },
    async find() {
      return { results: [...docs.values()] };
    },
    async getIncomingRelationships() {
      return { results: [] };
    },
  };
}

let h: Harness;
let ledgerDb: Kysely<VetraLicensingDB>;
let mem: ReturnType<typeof memReactor>;
let error: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  h = await makeHarness();
  ledgerDb = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  // vetra-apps creates the table itself (boot order is not fixed); the
  // licensing migrations creating it again afterwards must be a no-op.
  await ensureLedgerTables(ledgerDb as Kysely<any>);
  await licensingUp(ledgerDb as Kysely<any>);
  mem = memReactor();
  error = vi.fn();
});
afterEach(async () => {
  await ledgerDb.destroy();
  await h.close();
});

const ledger = (source = reactorLedgerSource(mem)) =>
  createAppLedger({
    db: ledgerDb,
    source,
    now: () => "2026-10-08T00:00:00.000Z",
    logger: { error, warn: vi.fn() },
  });
const store = (l: () => Promise<AppLedger> = async () => ledger()) =>
  createReactorAppDocStore(mem, undefined, l, { error });
const reads = () =>
  createAppReads(mem, {
    ledger: createLedgerLookup(ledgerDb),
    heal: ledger().heal,
    logger: { warn: vi.fn(), error: vi.fn() },
  });

const artifact = (over: Record<string, unknown> = {}) => ({
  appId: "",
  kind: "FUSION_IMAGE" as const,
  name: "shop",
  version: "1.2.3",
  reference: "cr.vetra.io/p/shop:1.2.3",
  channel: "LATEST" as const,
  ...over,
});
const ci = () => ciIdentity(claim("refs/heads/main"));

describe("app document writes from vetra-apps record the ledger", () => {
  it("CI artifact registration on a mirrored app leaves the app clean", async () => {
    h.deps.docs = store();
    const app = await seedActiveApp(h);
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));
    await ciRecordArtifact(
      h.deps,
      ci(),
      artifact({ appId: app.id, version: "1.2.4", reference: "cr.vetra.io/p/shop:1.2.4" }),
    );

    const view = await reads().app(app.id);
    expect(view?.artifacts[0]?.channels).toStrictEqual([
      { channel: "LATEST", version: "1.2.4" },
    ]);
    expect(view).toMatchObject({ tampered: false, unverified: false });
    expect(error).not.toHaveBeenCalled();
  });

  it("CI create-on-demand records the document it creates", async () => {
    const app = await seedActiveApp(h); // no document store yet: no document
    h.deps.docs = store();
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));
    expect(await reads().app(app.id)).toMatchObject({
      tampered: false,
      unverified: false,
    });
  });

  it("the boot backfill records what it creates", async () => {
    const app = await seedActiveApp(h);
    const out = await backfillAppDocuments({
      db: h.deps.db,
      docs: store(),
      logger: { warn: vi.fn() },
    });
    expect(out).toStrictEqual({ created: 1, skipped: 0 });
    expect(await reads().app(app.id)).toMatchObject({
      tampered: false,
      unverified: false,
    });
  });

  it("an artifact version recorded outside the store reads as tampered", async () => {
    h.deps.docs = store();
    const app = await seedActiveApp(h);
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));

    // A foreign version, written straight to the reactor.
    await mem.execute(app.id, "main", [
      recordArtifactVersion({
        kind: "FUSION_IMAGE",
        name: "shop",
        version: "6.6.6",
        reference: "attacker.io/evil:6.6.6",
        publishedAt: "2026-10-08T00:00:00.000Z",
      }),
    ] as Action[]);
    expect(await reads().app(app.id)).toMatchObject({
      tampered: true,
      tamperReason: "licensing state changed outside Vetra",
    });

  });

  it("a channel pointer moved outside the store reads as tampered", async () => {
    h.deps.docs = store();
    const channelOnly = await seedActiveApp(h);
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: channelOnly.id }));
    await ciRecordArtifact(
      h.deps,
      ci(),
      artifact({ appId: channelOnly.id, version: "1.2.4", reference: "r:1.2.4", channel: null }),
    );
    expect(await reads().app(channelOnly.id)).toMatchObject({ tampered: false });
    await mem.execute(channelOnly.id, "main", [
      setArtifactChannel({ kind: "FUSION_IMAGE", name: "shop", channel: "LATEST", version: "1.2.4" }),
    ] as Action[]);
    expect(await reads().app(channelOnly.id)).toMatchObject({ tampered: true });
  });

  it("a later CI write does not launder a foreign change: the app stays tampered", async () => {
    h.deps.docs = store();
    const app = await seedActiveApp(h);
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));
    await mem.execute(app.id, "main", [
      setArtifactChannel({ kind: "FUSION_IMAGE", name: "shop", channel: "DEV", version: "1.2.3" }),
    ] as Action[]);

    await ciRecordArtifact(
      h.deps,
      ci(),
      artifact({ appId: app.id, version: "1.2.4", reference: "r:1.2.4" }),
    );
    expect(await reads().app(app.id)).toMatchObject({ tampered: true });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("changed outside Vetra"),
    );
  });

  it("leaves a document it did not create and that was never recorded unverified", async () => {
    const app = await seedActiveApp(h);
    await createReactorAppDocStore(mem).create(app.id); // e.g. created before the ledger existed
    h.deps.docs = store();
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));
    expect(await reads().app(app.id)).toMatchObject({
      tampered: false,
      unverified: true,
    });
  });

  it("a record failure after a successful CI write is logged, not thrown, and healed on the next read", async () => {
    h.deps.docs = store();
    const app = await seedActiveApp(h);
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id }));
    const source = reactorLedgerSource(mem);
    let failOps = true;
    const flaky = {
      getDoc: source.getDoc,
      operationsSince: async (id: string, rev: number) => {
        if (failOps) {
          failOps = false;
          throw new Error("connection reset");
        }
        return source.operationsSince(id, rev);
      },
    };
    h.deps.docs = store(async () => ledger(flaky));
    await expect(
      ciRecordArtifact(
        h.deps,
        ci(),
        artifact({ appId: app.id, version: "1.2.4", reference: "r:1.2.4" }),
      ),
    ).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("intent journal"));
    expect(await reads().app(app.id)).toMatchObject({ tampered: false, unverified: false });
  });

  it("a ledger that failed to initialise is retried on the next write, not disabled", async () => {
    const app = await seedActiveApp(h);
    let attempts = 0;
    h.deps.docs = store(
      lazyLedger(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("namespace unavailable");
        return ledger();
      }),
    );
    // Create-on-demand: the document is created; recording it fails and is logged.
    await ciRecordArtifact(h.deps, ci(), artifact({ appId: app.id })).catch(() => undefined);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not recorded"));
    await ciRecordArtifact(
      h.deps,
      ci(),
      artifact({ appId: app.id, version: "1.2.4", reference: "r:1.2.4" }),
    );
    expect(attempts).toBe(2);
    // The creation went unrecorded, so the document stays unverified (never laundered).
    expect(await reads().app(app.id)).toMatchObject({ tampered: false, unverified: true });
  });
});
