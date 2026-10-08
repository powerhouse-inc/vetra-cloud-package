import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import type { MigrationDeps } from "../migration/steps.js";
import {
  checkLegacyTypesCovered,
  runLicensingMigration,
  startLicensingMigration,
} from "../migration/run.js";
import { STUDIO_APP_ID } from "../migration/studio.js";

/** Every dependency refuses unless a test sets it: nothing is called by accident. */
const refuse = () => vi.fn(() => Promise.reject(new Error("must not be called")));

let db: Kysely<VetraLicensingDB>;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.destroy();
});

function fakeDeps(over: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    db,
    accessDb: null,
    appRows: refuse(),
    legacyTypeDocs: refuse(),
    licences: refuse(),
    apps: { app: refuse(), appBySlug: refuse() },
    appWriter: { appendLicensingOps: refuse() },
    ledger: { lookup: refuse(), seed: refuse() },
    createAppDocument: refuse(),
    protectAppDocument: null,
    licenseGateway: { activate: refuse(), expire: refuse(), create: refuse(), execute: refuse() },
    envState: refuse(),
    deleteDocument: refuse(),
    grants: {} as MigrationDeps["grants"],
    cfg: { migration: "apply", deleteLicenseTypes: false, studioAppSlug: "vetra-studio", studioPublisher: "0x00000000000000000000000000000000000000bb" },
    now: () => "2026-10-08T00:00:00.000Z",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

/**
 * A world with nothing to migrate except a studio app that is already
 * exactly right: a run is clean, so apply completes.
 */
function cleanWorld(over: Partial<MigrationDeps> = {}): MigrationDeps {
  const studioView = {
    id: STUDIO_APP_ID, name: "Vetra Studio", slug: "vetra-studio", owner: "0x00000000000000000000000000000000000000bb",
    status: "ACTIVE", identityDid: null, productionEnvironmentId: null, artifacts: [], tampered: false, tamperReason: null,
    licensingStateHash: "h", unverified: false,
    templates: [{ id: "studio", name: "Studio early access", mode: "SHARED", sharedEnvironment: null, templateHash: "x", resolutionError: null,
      template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null } }],
    terms: [{ id: "studio-early-access-30d", kind: "studio-early-access-30d", label: "Studio early access (30 days)", templateId: "studio",
      validityDays: 30, issuers: ["INVITE_CODE"], status: "ACTIVE" }],
  } as const;
  return fakeDeps({
    appRows: vi.fn(async () => []),
    legacyTypeDocs: vi.fn(async () => []),
    licences: vi.fn(async () => []),
    apps: { app: vi.fn(async () => structuredClone(studioView) as never), appBySlug: vi.fn(async () => structuredClone(studioView) as never) },
    ledger: { lookup: vi.fn(async () => "h"), seed: refuse() },
    grants: { chainRoots: vi.fn(async () => new Map()) } as unknown as MigrationDeps["grants"],
    ...over,
  });
}

const steps = () => db.selectFrom("licensing_migration_steps").select("step").execute();

describe("runLicensingMigration", { timeout: 30_000 }, () => {
  it("does nothing in mode off", async () => {
    const deps = fakeDeps({ cfg: { ...fakeDeps().cfg, migration: "off" } });
    expect(await runLicensingMigration(deps)).toStrictEqual({
      mode: "dry-run", actions: [], problems: [], warnings: [], complete: false, deletionComplete: false,
    });
    expect(deps.appRows).not.toHaveBeenCalled();
    expect(deps.legacyTypeDocs).not.toHaveBeenCalled();
    expect(await steps()).toStrictEqual([]);
  });

  it("never throws: a step that throws becomes a problem, and the other steps still run", async () => {
    const deps = cleanWorld({ legacyTypeDocs: vi.fn(() => Promise.reject(new Error("boom"))) });
    const report = await runLicensingMigration(deps);
    expect(report.problems).toStrictEqual(["step license-types failed: boom"]);
    expect(report.complete).toBe(false);
    expect(deps.licences).toHaveBeenCalled();
    expect(await steps()).toStrictEqual([]);
  });

  it("never throws even when the database itself fails", async () => {
    const broken = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) }); // no tables
    const deps = cleanWorld({ db: broken, logger: { info: vi.fn(), warn: vi.fn(() => { throw new Error("logger down"); }), error: vi.fn() } });
    const report = await runLicensingMigration(deps);
    expect(report.complete).toBe(false);
    expect(report.problems[0]).toMatch(/^migration failed: /);
    await broken.destroy();
  });

  it("completes a clean world in apply, and only in apply", async () => {
    const dry = await runLicensingMigration(cleanWorld({ cfg: { ...fakeDeps().cfg, migration: "dry-run" } }));
    expect(dry).toMatchObject({ mode: "dry-run", complete: false, problems: [], actions: [] });
    expect(await steps()).toStrictEqual([]);

    const deps = cleanWorld();
    const report = await runLicensingMigration(deps);
    expect(report).toMatchObject({ mode: "apply", complete: true, problems: [], actions: [] });
    expect(await steps()).toStrictEqual([{ step: "complete" }]);
    expect(deps.logger.warn).toHaveBeenCalledWith("[licensing] migration (apply): 0 actions, 0 problems, 0 warnings, complete");

    // Once complete, a run does no work at all.
    const after = cleanWorld({ appRows: refuse(), legacyTypeDocs: refuse(), licences: refuse() });
    expect(await runLicensingMigration(after)).toMatchObject({ complete: true, actions: [], problems: [] });
  });

  it("does not complete when the verification pass still finds work", async () => {
    // A studio app that the reconcile cannot make stick: the write "succeeds"
    // but the document never changes, so the dry-run pass sees it again.
    const deps = cleanWorld({
      apps: { app: vi.fn(async () => null), appBySlug: vi.fn(async () => null) },
      createAppDocument: vi.fn(async () => {}),
      appWriter: { appendLicensingOps: vi.fn(async () => {}) },
    });
    const report = await runLicensingMigration(deps);
    expect(report.complete).toBe(false);
    expect(report.problems.some((p) => p.startsWith("still pending after apply: studio: create app document"))).toBe(true);
    expect(await steps()).toStrictEqual([]);
  });

  it("refuses to build the studio without a publisher, and a slug held by another app", async () => {
    const noPublisher = await runLicensingMigration(cleanWorld({ cfg: { ...fakeDeps().cfg, studioPublisher: null } }));
    expect(noPublisher.problems).toStrictEqual(["studio: set VETRA_STUDIO_PUBLISHER_ADDRESS (or ADMINS) to create the vetra-studio app"]);
    const other = cleanWorld();
    other.apps.appBySlug = vi.fn(async () => ({ id: "other-app" }) as never);
    const taken = await runLicensingMigration(other);
    expect(taken.problems).toStrictEqual([`studio: slug vetra-studio belongs to app other-app; rename it, the studio app is ${STUDIO_APP_ID}`]);
  });

  it("holds the studio when its recorded document was changed outside Vetra", async () => {
    const deps = cleanWorld({ ledger: { lookup: vi.fn(async (id: string) => (id === STUDIO_APP_ID ? "recorded-other" : "h")), seed: refuse() } });
    const report = await runLicensingMigration(deps);
    expect(report.problems).toStrictEqual([
      `studio: app document ${STUDIO_APP_ID} was changed outside Vetra after it was recorded; investigate before migrating studio licences`,
    ]);
  });
});

describe("checkLegacyTypesCovered", () => {
  const typeDoc = { header: { id: "t1", documentType: "powerhouse/app-license-type" }, state: { global: { status: "DRAFT" } } };

  it("is loud while licence types exist and none is mapped, quieter once mapped, silent when gone", async () => {
    const deps = fakeDeps({ legacyTypeDocs: vi.fn(async () => [typeDoc]) });
    await checkLegacyTypesCovered(deps);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("1 app-license-type document(s) exist and the licensing migration has mapped none of them"));
    await db.insertInto("licensing_migration_type_map").values({ license_type_id: "t1", app_id: "a", kind: "k", template_id: "", term_id: "", created_at: "t" }).execute();
    await checkLegacyTypesCovered(deps);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("1 app-license-type document(s) remain (1 mapped)"));
    const gone = fakeDeps({ legacyTypeDocs: vi.fn(async () => []) });
    await checkLegacyTypesCovered(gone);
    expect(gone.logger.error).not.toHaveBeenCalled();
    expect(gone.logger.warn).not.toHaveBeenCalled();
    const failing = fakeDeps();
    await checkLegacyTypesCovered(failing);
    expect(failing.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not check the legacy licence types"));
  });
});

describe("startLicensingMigration", { timeout: 30_000 }, () => {
  it("logs and does nothing in mode off", async () => {
    const deps = fakeDeps({ cfg: { ...fakeDeps().cfg, migration: "off" }, legacyTypeDocs: vi.fn(async () => []) });
    startLicensingMigration(deps).stop();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("LICENSING_MIGRATION=off"));
    expect(deps.appRows).not.toHaveBeenCalled();
  });

  it("retries every interval until complete, then stops", async () => {
    vi.useFakeTimers();
    let runs = 0;
    // Not complete on the first pass (a step fails), complete on the second.
    const deps = cleanWorld({
      appRows: vi.fn(async () => {
        runs++;
        if (runs === 1) throw new Error("first pass fails");
        return [];
      }),
    });
    const handle = startLicensingMigration(deps, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await steps()).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await steps()).toStrictEqual([{ step: "complete" }]);
    const after = runs;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(after);
    handle.stop();
  });

  it("keeps going after completion until the asked-for deletion is done", async () => {
    vi.useFakeTimers();
    await db.insertInto("licensing_migration_steps").values({ step: "complete", completed_at: "t", detail: null }).execute();
    await db.insertInto("licensing_migration_type_map").values({ license_type_id: "t1", app_id: "a", kind: "k", template_id: "", term_id: "", created_at: "t" }).execute();
    let docs: unknown[] = [{ header: { id: "t1", documentType: "powerhouse/app-license-type" }, state: { global: { status: "DRAFT" } } }];
    let failDelete = true;
    const deps = cleanWorld({
      cfg: { ...fakeDeps().cfg, deleteLicenseTypes: true },
      legacyTypeDocs: vi.fn(async () => docs),
      deleteDocument: vi.fn(async () => {
        if (failDelete) throw new Error("reactor busy");
        docs = [];
      }),
    });
    const handle = startLicensingMigration(deps, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.logger.warn).toHaveBeenCalledWith("[licensing] migration problem: licence type document t1: delete failed: reactor busy");
    failDelete = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(docs).toStrictEqual([]);
    expect(deps.logger.warn).toHaveBeenCalledWith("[licensing] migration: deleted 1 app-license-type document(s); none remain");
    const calls = (deps.deleteDocument as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect((deps.deleteDocument as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    handle.stop();
  });

  it("logs a dry-run's findings in full once, then only its summary while they do not change", async () => {
    vi.useFakeTimers();
    const deps = cleanWorld({
      cfg: { ...fakeDeps().cfg, migration: "dry-run" },
      apps: { app: vi.fn(async () => null), appBySlug: vi.fn(async () => null) },
    });
    const handle = startLicensingMigration(deps, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const lines = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith("[licensing] migration dry-run: studio: create app document"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("[licensing] migration (dry-run): 1 actions"))).toHaveLength(2);
    handle.stop();
  });
});
