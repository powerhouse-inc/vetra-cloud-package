import { keyedMutex } from "../keyed-mutex.js";
import {
  deleteLegacyLicenseTypes,
  migrateEnvironments,
  migrateLicences,
  migrateLicenseTypes,
  migrateStudio,
  newContext,
  recordLifecycles,
  seedLedger,
  type MigrationContext,
  type MigrationDeps,
  type MigrationMode,
  type MigrationReport,
} from "./steps.js";

type Step = (deps: MigrationDeps, report: MigrationReport, ctx: MigrationContext) => Promise<void>;

/**
 * In order: licences need the type map, environments need kinds, lifecycle
 * needs the chains environments link, the ledger comes last.
 */
const STEPS: [string, Step][] = [
  ["license-types", migrateLicenseTypes],
  ["licences", migrateLicences],
  ["environments", migrateEnvironments],
  ["lifecycle", recordLifecycles],
  ["studio", migrateStudio],
  ["ledger", seedLedger],
];

export const COMPLETE_STEP = "complete";

export interface MigrationResult extends MigrationReport {
  /** The `complete` marker is recorded: the handler may run. */
  complete: boolean;
  /** Legacy licence types were deleted (asked for) and none remain. */
  deletionComplete: boolean;
}

/** One migration at a time in this process (production runs one replica). */
const withMigrationLock = keyedMutex();

const report = (mode: MigrationMode): MigrationReport => ({ mode, actions: [], problems: [], warnings: [] });

export interface RunOptions {
  quietIfUnchanged?: (r: MigrationReport) => boolean;
  /** Checked between steps: true once the subgraph is shutting down. */
  stopped?: () => boolean;
}

/** False when the run was stopped part-way (a problem says so). */
async function runSteps(deps: MigrationDeps, r: MigrationReport, label: string, opts: RunOptions): Promise<boolean> {
  const ctx = newContext();
  for (const [name, step] of STEPS) {
    if (opts.stopped?.()) {
      r.problems.push(`${label} stopped before ${name}: shutting down`);
      return false;
    }
    try {
      await step(deps, r, ctx);
    } catch (err) {
      r.problems.push(`${label} ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return true;
}

async function isComplete(deps: MigrationDeps): Promise<boolean> {
  return (
    (await deps.db
      .selectFrom("licensing_migration_steps")
      .select("step")
      .where("step", "=", COMPLETE_STEP)
      .executeTakeFirst()) !== undefined
  );
}

/**
 * Everything at warn: production runs with LOG_LEVEL=warn, which hides
 * info from subgraphs, and these lines are what operators read before
 * switching to apply.
 */
function log(deps: MigrationDeps, r: MigrationReport, extra: string, quiet: boolean): void {
  deps.logger.warn(
    `[licensing] migration (${r.mode}): ${r.actions.length} actions, ${r.problems.length} problems, ${r.warnings.length} warnings${extra}`,
  );
  if (quiet) return;
  for (const a of r.actions) deps.logger.warn(`[licensing] migration ${r.mode}: ${a}`);
  for (const w of r.warnings) deps.logger.warn(`[licensing] migration warning: ${w}`);
  for (const p of r.problems) deps.logger.warn(`[licensing] migration problem: ${p}`);
}

async function runUnlocked(deps: MigrationDeps, opts: RunOptions): Promise<MigrationResult> {
  const mode = deps.cfg.migration;
  if (mode === "off") {
    return { ...report("dry-run"), complete: false, deletionComplete: false };
  }
  const r = report(mode);
  let complete = await isComplete(deps);
  if (!complete) {
    await runSteps(deps, r, "step", opts);
    // Verification: a dry-run pass over what apply left must find nothing.
    // `complete` is written only in apply mode and only after it is clean.
    if (mode === "apply" && r.problems.length === 0) {
      const verify = report("dry-run");
      const ran = await runSteps(deps, verify, "verify", opts);
      if (ran && verify.actions.length === 0 && verify.problems.length === 0 && !opts.stopped?.()) {
        await deps.db
          .insertInto("licensing_migration_steps")
          .values({ step: COMPLETE_STEP, completed_at: deps.now(), detail: `${r.actions.length} actions in the completing run` })
          .onConflict((oc) => oc.column("step").doNothing())
          .execute();
        complete = true;
      } else {
        r.problems.push(...verify.problems, ...verify.actions.map((a) => `still pending after apply: ${a}`));
      }
    }
  }
  // The legacy licence types go only once everything else is complete, and
  // only when asked (LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true).
  let deletionComplete = false;
  if (complete && deps.cfg.deleteLicenseTypes && !opts.stopped?.()) {
    try {
      deletionComplete = await deleteLegacyLicenseTypes(deps, r);
    } catch (err) {
      r.problems.push(`delete licence types failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(deps, r, complete ? ", complete" : "", opts.quietIfUnchanged?.(r) ?? false);
  return { ...r, complete, deletionComplete };
}

/** One full pass. Never throws: every failure is a problem in the result. */
export async function runLicensingMigration(deps: MigrationDeps, opts: RunOptions = {}): Promise<MigrationResult> {
  try {
    return await withMigrationLock("licensing-migration", () => runUnlocked(deps, opts));
  } catch (err) {
    const r = report(deps.cfg.migration === "apply" ? "apply" : "dry-run");
    r.problems.push(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      deps.logger.warn(`[licensing] migration failed: ${r.problems[0]}`);
    } catch {
      // A logger that throws must not escape either.
    }
    return { ...r, complete: false, deletionComplete: false };
  }
}

/**
 * The release after this one removes the app-license-type model; documents
 * of that type it cannot load are stranded. Loud until they are gone.
 */
export async function checkLegacyTypesCovered(deps: MigrationDeps): Promise<void> {
  try {
    const docs = (await deps.legacyTypeDocs()).length;
    if (docs === 0) return;
    const mapped = (await deps.db.selectFrom("licensing_migration_type_map").select("license_type_id").execute()).length;
    if (mapped === 0) {
      deps.logger.error(
        `[licensing] ${docs} app-license-type document(s) exist and the licensing migration has mapped none of them: run LICENSING_MIGRATION=apply, then LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true, BEFORE deploying the release that removes the app-license-type model`,
      );
    } else {
      deps.logger.warn(
        `[licensing] ${docs} app-license-type document(s) remain (${mapped} mapped): set LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true once the migration is complete`,
      );
    }
  } catch (err) {
    deps.logger.warn(`[licensing] could not check the legacy licence types: ${String(err)}`);
  }
}

/**
 * Starts the migration without blocking: one pass now, then every
 * `intervalMs` until it is complete (and, when asked, the legacy types are
 * deleted). Never throws. A dry-run whose findings did not change since the
 * last pass logs only its summary line.
 */
export function startLicensingMigration(deps: MigrationDeps, intervalMs = 600_000): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let lastFindings: string | null = null;
  let stopped = false;
  /** Also ends an in-flight pass at its next step boundary. */
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  void checkLegacyTypesCovered(deps);
  if (deps.cfg.migration === "off") {
    deps.logger.warn("[licensing] LICENSING_MIGRATION=off: the licence handler stays idle until the migration completes");
    return { stop };
  }
  const quietIfUnchanged = (r: MigrationReport) => {
    const findings = JSON.stringify([r.actions, r.problems, r.warnings]);
    const same = findings === lastFindings;
    lastFindings = findings;
    return same;
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (stopped) return;
      const result = await runLicensingMigration(deps, { quietIfUnchanged, stopped: () => stopped });
      if (result.complete && (!deps.cfg.deleteLicenseTypes || result.deletionComplete)) stop();
    } finally {
      busy = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop };
}
