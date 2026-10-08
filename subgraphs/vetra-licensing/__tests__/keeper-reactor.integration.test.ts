import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions } from "document-models/app-owner-license";
import { actions as appActions } from "document-models/vetra-app";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createAppReads } from "../app-reads.js";
import { createGrantStore } from "../grants.js";
import { createLifecycleStore } from "../lifecycle.js";
import { issueLicense } from "../issue.js";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { LicenseKeeper } from "../keeper.js";
import { loadLicensingConfig, type LicensingConfig } from "../config.js";

/**
 * The seam every other test on this branch mocks.
 *
 * `reads.ts`, `license-gateway.ts` and `keeper.ts` are each unit-tested against
 * hand-written fakes, which is how two Criticals hid during review: a fake that
 * always resolves cannot show that a reducer rejected the action. This test
 * wires the three to a REAL reactor (in-memory PGlite, no Postgres, no
 * switchboard) and drives real licence documents through the real reducers.
 *
 * What it proves that the unit tests cannot:
 *  - `find({ type })` really returns documents this code created
 *  - the gateway's rejection detection reads back real operations
 *  - ACTIVATE_LICENSE / EXPIRE_LICENSE are really accepted by the reducer, so a
 *    keeper tick actually moves a licence rather than silently no-opping
 */

const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The keeper reads the time through `now()`, so the test drives it rather than
 * the wall clock. An earlier version used real timestamps a few ms apart and
 * was flaky under a loaded parallel run: the first tick already fell past a
 * 50ms window, so a licence reached EXPIRED before the ACTIVE assertion.
 */
const BASE = Date.parse("2026-06-01T12:00:00.000Z");
let clock = BASE;

const cfg: LicensingConfig = {
  ...loadLicensingConfig({}),
  enabled: true,
  dryRun: false,
  scanIntervalMs: 1_000,
  defaultMaxEnvironments: 50,
};

const silentLogger = { info: () => {}, warn: () => {} };

// The keeper never dereferences a licence's `app`, so a fixed id is honest for
// the hand-built licences; the issueLicense test uses a real vetra-app document.
const APP = "7d1f6f5c-1f0e-4a8b-9d55-0c3b9b8f2a11";
const USER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("LicenseKeeper against a real reactor", () => {
  let client: Client;
  let reads: ReturnType<typeof createReactorLicenseReads>;
  let keeper: LicenseKeeper;
  let db: Kysely<VetraLicensingDB>;
  let gateway: ReturnType<typeof createReactorLicenseGateway>;
  let issueDeps: Parameters<typeof issueLicense>[0];

  beforeAll(async () => {
    clock = BASE;
    client = await new ReactorClientBuilder()
      .withReactorBuilder(
        new ReactorBuilder().withDocumentModelSources([...documentModels]),
      )
      .build();

    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    const lifecycle = createLifecycleStore(db, () => iso(clock));
    reads = createReactorLicenseReads(client as never);
    gateway = createReactorLicenseGateway(client as never, { lifecycle });

    const appDocs = createReactorAppDocStore(client as never);
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.addTemplate({ id: "t", name: null, mode: "DEDICATED" }),
      appActions.addTerm({ id: "k", kind: "pro", label: null, templateId: "t", validityDays: 1, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k" }),
    ]);
    issueDeps = {
      owners: {
        findAppById: async (id) =>
          id === APP ? { id, name: "KV", status: "ACTIVE", owner_address: "0xowner" } : null,
      },
      apps: createAppReads(client as never),
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: gateway.create,
      executeLicence: gateway.execute,
      grants: createGrantStore(db),
      lifecycle,
      migrationComplete: async () => false,
      logger: console,
    };

    keeper = new LicenseKeeper({
      listLicenses: () => reads.listLicenses(),
      activate: (id) => gateway.activate(id),
      expire: (id) => gateway.expire(id),
      now: () => iso(clock),
      cfg,
      logger: silentLogger,
    });
  }, 120_000);

  afterAll(async () => {
    const c = client as unknown as { shutdown?: () => Promise<void> };
    await c.shutdown?.();
  });

  /**
   * Creates a licence document and issues it (ISSUE_LICENSE only, no
   * ACTIVATE_LICENSE) through the real reducer, recording the lifecycle as the
   * gateway does for every system write.
   */
  async function issue(opts: {
    start: string;
    end: string | null;
  }): Promise<string> {
    const id = await gateway.create();
    await gateway.execute(id, [
      actions.issueLicense({
        app: APP,
        user: USER,
        issuer: "PUBLISHER_GRANT",
        kind: "pro",
        stage: null,
        details: null,
        issued: opts.start,
        start: opts.start,
        end: opts.end,
      }),
    ]);
    return id;
  }

  const recorded = async (id: string) =>
    (await db.selectFrom("license_lifecycle").select("status").where("license_id", "=", id).executeTakeFirst())?.status ?? null;

  async function statusOf(id: string): Promise<string | null> {
    const rows = await reads.listLicenses();
    return rows.find((r) => r.id === id)?.status ?? null;
  }

  it("moves a started licence ISSUED -> ACTIVE, and expires one already past its end", async () => {
    clock = BASE;
    const now = BASE;

    const started = await issue({
      start: iso(now - HOUR),
      end: iso(now + HOUR),
    });
    const lapsed = await issue({
      start: iso(now - 2 * HOUR),
      end: iso(now - HOUR),
    });
    const future = await issue({ start: iso(now + HOUR), end: null });

    // The documents really exist in the reactor and are findable by type.
    const before = await reads.listLicenses();
    const ids = before.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([started, lapsed, future]));
    expect(before.find((r) => r.id === started)?.status).toBe("ISSUED");

    await keeper.reconcileOnce();

    expect(await statusOf(started)).toBe("ACTIVE");
    // Past its end, so it is expired WITHOUT first being activated -- activating
    // it would provision an environment only to tear it down on the next tick.
    expect(await statusOf(lapsed)).toBe("EXPIRED");
    // Not started yet: untouched.
    expect(await statusOf(future)).toBe("ISSUED");
    // Every keeper write is recorded in license_lifecycle.
    expect(await recorded(started)).toBe("ACTIVE");
    expect(await recorded(lapsed)).toBe("EXPIRED");
    expect(await recorded(future)).toBe("ISSUED");
  }, 120_000);

  it("is a no-op on a second tick", async () => {
    const before = await reads.listLicenses();
    await keeper.reconcileOnce();
    const after = await reads.listLicenses();

    const norm = (rows: typeof before) =>
      [...rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.status]);
    expect(norm(after)).toEqual(norm(before));
  }, 120_000);

  it("expires an ACTIVE licence once its end passes", async () => {
    clock = BASE;
    const soon = await issue({
      start: iso(BASE - HOUR),
      end: iso(BASE + HOUR),
    });

    await keeper.reconcileOnce();
    expect(await statusOf(soon)).toBe("ACTIVE");

    // Advance past its end. No sleep: the keeper's only clock is now().
    clock = BASE + 2 * HOUR;

    await keeper.reconcileOnce();
    expect(await statusOf(soon)).toBe("EXPIRED");
  }, 120_000);

  it("surfaces a reducer rejection instead of reporting success", async () => {
    // EXPIRED is terminal, so expiring it again must be rejected by the reducer.
    // The gateway has to notice that from the appended operations, because
    // reactor execute() does not throw on a rejection.
    clock = BASE;
    const id = await issue({
      start: iso(BASE - 2 * HOUR),
      end: iso(BASE - HOUR),
    });
    await keeper.reconcileOnce();
    expect(await statusOf(id)).toBe("EXPIRED");

    await expect(gateway.expire(id)).rejects.toThrow();
  }, 120_000);

  it("expires a licence issued through issueLicense once its term's end passes", async () => {
    // issueLicense issues AND activates, ending validityDays (1) after `now`.
    const issued = await issueLicense(issueDeps, {
      appId: APP, user: USER, kind: "pro", issuer: "PUBLISHER_GRANT", details: {},
      issuedBy: "0xowner", label: null, now: iso(BASE),
    });
    clock = BASE;
    expect(await statusOf(issued.licenseId)).toBe("ACTIVE");
    await keeper.reconcileOnce();
    expect(await statusOf(issued.licenseId)).toBe("ACTIVE");

    clock = BASE + 25 * HOUR;
    await keeper.reconcileOnce();
    expect(await statusOf(issued.licenseId)).toBe("EXPIRED");
    expect(await recorded(issued.licenseId)).toBe("EXPIRED");
  }, 120_000);
});
