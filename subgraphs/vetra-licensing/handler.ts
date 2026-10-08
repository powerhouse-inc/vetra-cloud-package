import type { LicensingConfig } from "./config.js";
import { resolveKind, type AppDocView } from "./app-reads.js";
import {
  planChains,
  type ChainStep,
  type PlanLicence,
  type PlanResolution,
} from "./chain-plan.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { didForAddress, normaliseUserDid } from "./did.js";
import {
  EnvironmentNotReadyError,
  EnvironmentOwnershipMismatchError,
  type ProvisionChainInput,
} from "./environments.js";
import type { GrantProvenance } from "./grants.js";
import type { LifecycleRecord } from "./lifecycle.js";
import { UNAPPLIED_TEMPLATE_HASH } from "./provision.js";
import type { LicenceRecord } from "./reads.js";

export interface HandlerDeps {
  licences(): Promise<LicenceRecord[]>;
  /** licence id -> chain root (license_chain); an absent licence is its own root. */
  chainRoots(): Promise<Map<string, string>>;
  /**
   * licence id -> what its app_license_grants row authorised. A licence
   * without a row, or whose document disagrees with its row (app, holder or
   * kind), is unauthorised: it provisions nothing and its chain is held.
   */
  grants(): Promise<Map<string, GrantProvenance>>;
  /**
   * licence id -> the lifecycle status the system last wrote
   * (license_lifecycle). A document that disagrees holds its chain, and so does
   * an authorised licence with no row (the migration backfills every one).
   */
  lifecycle(): Promise<Map<string, LifecycleRecord>>;
  chainLabel(rootLicenseId: string): Promise<string | null>;
  /** Through createAppReads: carries the tampered/unverified integrity flags. */
  app(appId: string): Promise<AppDocView | null>;
  environments(appId: string): Promise<LicenseEnvironments[]>;
  environmentAppIds(): Promise<string[]>;
  provision(input: ProvisionChainInput): Promise<LicenseEnvironments>;
  setStage(licenseId: string, stage: string): Promise<void>;
  /** Task 10 wires the offboarding clock here; until then they only log. */
  onEnded(appId: string, environmentId: string): Promise<void>;
  onResumed(appId: string, environmentId: string): Promise<void>;
  /**
   * Runs after an app's steps (offboarding ticks, reporting tokens); never for a held app.
   * `confirmedEndedRoots` are the chains this tick affirmatively confirmed as
   * ended (no head, all terminal, not held, not backed off, evaluated and
   * settled this tick). An environment row with ended_at set whose root is not
   * in it is FROZEN: it must be neither stopped nor destroyed.
   */
  afterApp(
    appId: string,
    environments: LicenseEnvironments[],
    confirmedEndedRoots: ReadonlySet<string>,
  ): Promise<void>;
  /** True once the startup migration recorded `complete`. */
  migrationComplete(): Promise<boolean>;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn" | "error">;
  now(): string;
}

/** A handler step (or read) did not settle within cfg.stepTimeoutMs. */
export class StepTimeoutError extends Error {
  override name = "StepTimeoutError";
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Level = "info" | "warn" | "error";

/**
 * Logs a condition when it appears or its message changes, not every tick.
 * A key not noted during a completed tick has resolved and is forgotten, so
 * it is logged again if it comes back.
 */
class Notices {
  private last = new Map<string, string>();
  private seen = new Set<string>();
  constructor(private readonly logger: Pick<Console, Level>) {}

  note(key: string, level: Level, message: string): void {
    this.seen.add(key);
    if (this.last.get(key) === message) return;
    this.last.set(key, message);
    this.logger[level](message);
  }

  /** After an aborted tick nothing is forgotten: unvisited keys were not re-checked. */
  endTick(completed: boolean): void {
    if (completed) {
      for (const key of [...this.last.keys()]) if (!this.seen.has(key)) this.last.delete(key);
    }
    this.seen.clear();
  }
}

/** A parseable timestamp in canonical ISO form; anything else is null (sorts oldest). */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Why the licence document is not backed by its grant row, or null when it is. */
function unauthorisedBecause(l: LicenceRecord, grant: GrantProvenance | undefined): string | null {
  if (!grant) return "has no provenance";
  if (grant.appId !== l.app) return `claims app ${l.app} but was granted for app ${grant.appId}`;
  let holder: string;
  try {
    holder = normaliseUserDid(l.user);
  } catch {
    return `has an unusable holder ${l.user}`;
  }
  const granted = didForAddress(grant.userAddress);
  if (holder !== granted) return `names holder ${holder} but was granted to ${granted}`;
  if (grant.kind !== null && grant.kind !== l.kind) {
    return `carries kind ${l.kind ?? "(none)"} but was granted kind ${grant.kind}`;
  }
  return null;
}

/** Why the document's lifecycle disagrees with what the system recorded, or null. */
function lifecycleMismatch(
  l: LicenceRecord,
  rec: LifecycleRecord | undefined,
  grant: GrantProvenance | undefined,
): string | null {
  // The handler runs only after the migration, which backfills every
  // licence: an authorised licence without a record is not one the system
  // can vouch for. (An unauthorised one is held for its provenance anyway.)
  if (!rec) return grant ? "has no recorded lifecycle (the system never recorded writing it)" : null;
  if (rec.status !== l.status) {
    return `its document says ${l.status} but the system recorded ${rec.status}`;
  }
  if (rec.status === "REPLACED" && rec.replacedBy !== null && rec.replacedBy !== l.replacedBy) {
    return `its document says replaced by ${l.replacedBy ?? "nothing"} but the system recorded ${rec.replacedBy}`;
  }
  return null;
}

const rootOfStep = (step: ChainStep, rootById: Map<string, string>): string | null =>
  step.kind === "set-stage" ? (rootById.get(step.licenseId) ?? null) : step.root;

/** The longest a failing chain is skipped for, in ticks. */
export const BACKOFF_CAP_TICKS = 16;

/** `list` starting at `offset` (mod its length), wrapping around. */
function rotate<T>(list: T[], offset: number): T[] {
  if (list.length === 0) return list;
  const k = offset % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

type ProvisionKind = "create" | "retemplate" | "repoint";

/**
 * AppLicenseHandler: licence -> app.terms[kind] -> app.templates[templateId]
 * -> by mode. Timer-driven, re-entrancy guarded, every app (and every step)
 * isolated from every other's failures, and every call bounded by
 * cfg.stepTimeoutMs so a hung call cannot stall later ticks.
 *
 * It never stops, releases or deletes an environment: an ended chain is only
 * reported (onEnded). Anything it cannot be sure of — the migration not yet
 * complete, an unreadable or tampered app, a licence without provenance or
 * disagreeing with it, a lifecycle the system did not write, an unreadable
 * chain member — is held and logged (once per change).
 *
 * Re-templating live environments is rate-limited (cfg.retemplatePerTick);
 * creation is limited only by the per-app cap.
 */
export class AppLicenseHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly notices: Notices;
  private retemplateBudget = 0;
  private deferredRetemplates = 0;
  private tickNo = 0;
  /** chain key -> consecutive failures and the last tick it is skipped on. */
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  /** Chain keys with a step that has not settled (including timed-out ones). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: HandlerDeps) {
    this.notices = new Notices(d.logger);
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err: unknown) =>
          this.d.logger.warn(`[licensing] handler tick failed: ${String(err)}`),
        )
        .finally(() => {
          this.running = false;
        });
    };
    tick();
    this.timer = setInterval(tick, this.d.cfg.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileOnce(): Promise<void> {
    if (!this.d.cfg.enabled) return;
    let completed = false;
    try {
      await this.tick();
      completed = true;
    } finally {
      this.notices.endTick(completed);
    }
  }

  private timed<T>(p: Promise<T>, what: string): Promise<T> {
    return withTimeout(p, this.d.cfg.stepTimeoutMs, what);
  }

  private async tick(): Promise<void> {
    // Before the migration, license_environments is empty while live
    // environments exist: planning now would provision a second environment
    // for every live holder.
    if (!(await this.timed(this.d.migrationComplete(), "migration check"))) {
      this.notices.note(
        "migration",
        "info",
        "[licensing] handler idle: waiting for the licensing migration to complete",
      );
      return;
    }

    const [licences, roots, grants, lifecycle] = await this.timed(
      Promise.all([this.d.licences(), this.d.chainRoots(), this.d.grants(), this.d.lifecycle()]),
      "licence reads",
    );
    const byApp = new Map<string, PlanLicence[]>();
    /** appId -> chain root -> why the whole chain is held. */
    const heldRoots = new Map<string, Map<string, string>>();
    const holdRoot = (appId: string, root: string, reason: string) => {
      const perApp = heldRoots.get(appId) ?? new Map<string, string>();
      if (!perApp.has(root)) perApp.set(root, reason);
      heldRoots.set(appId, perApp);
    };

    const read = new Set<string>();
    for (const l of licences) {
      read.add(l.id);
      const grant = grants.get(l.id);
      // The grant's app is authoritative: a licence document claiming another
      // app is planned (unauthorised) where its grant says it belongs.
      const appId = grant?.appId ?? l.app;
      const root = roots.get(l.id) ?? l.id;
      let user = l.user;
      let usable = true;
      try {
        user = normaliseUserDid(l.user);
      } catch {
        usable = false;
        // Kept in its chain, unauthorised: dropping it could leave only
        // terminal siblings, which would read as an ended chain.
        this.notices.note(
          `licence:${l.id}:holder`,
          "warn",
          `[licensing] licence ${l.id} has an unusable holder ${l.user}; holding its chain`,
        );
      }
      const why = unauthorisedBecause(l, grant);
      if (why && grant && usable) {
        this.notices.note(
          `licence:${l.id}:grant`,
          "warn",
          `[licensing] licence ${l.id} ${why}; holding its chain`,
        );
      }
      const mismatch = lifecycleMismatch(l, lifecycle.get(l.id), grant);
      if (mismatch) {
        this.notices.note(
          `licence:${l.id}:lifecycle`,
          "error",
          `[licensing] licence ${l.id}: ${mismatch}; holding chain ${root} (was the document written outside Vetra?)`,
        );
        holdRoot(appId, root, `licence ${l.id}: ${mismatch}`);
      }
      const list = byApp.get(appId) ?? [];
      list.push({
        id: l.id,
        user,
        kind: l.kind,
        status: l.status,
        issued: isoOrNull(l.issued ?? l.start),
        stage: l.stage,
        root,
        authorised: why === null,
        replacedBy: l.replacedBy,
      });
      byApp.set(appId, list);
    }

    // Authorised licences whose document could not be read: their chain's
    // state is unknown, never ended.
    for (const [id, grant] of grants) {
      if (read.has(id)) continue;
      holdRoot(
        grant.appId,
        roots.get(id) ?? id,
        `licence ${id} has provenance but its document could not be read`,
      );
    }

    for (const appId of await this.timed(this.d.environmentAppIds(), "environment app ids")) {
      if (!byApp.has(appId)) byApp.set(appId, []);
    }

    this.retemplateBudget = this.d.cfg.retemplatePerTick;
    this.deferredRetemplates = 0;
    this.tickNo++;
    // Rotated, so the same apps (and below, chains) do not always come first
    // and take the whole re-template budget.
    for (const [appId, appLicences] of rotate([...byApp], this.tickNo)) {
      try {
        await this.reconcileApp(appId, appLicences, heldRoots.get(appId) ?? new Map<string, string>());
      } catch (err) {
        this.notices.note(
          `app:${appId}:failed`,
          "warn",
          `[licensing] reconcile of app ${appId} failed: ${String(err)}`,
        );
      }
    }
    if (this.deferredRetemplates > 0) {
      this.notices.note(
        "retemplate-deferred",
        "info",
        `[licensing] ${this.deferredRetemplates} environment re-template(s) deferred to later ticks (at most ${this.d.cfg.retemplatePerTick} per tick)`,
      );
    }
  }

  private async reconcileApp(
    appId: string,
    licences: PlanLicence[],
    heldRoots: Map<string, string>,
  ): Promise<void> {
    const app = await this.timed(this.d.app(appId), `read of app ${appId}`);
    if (!app) {
      this.notices.note(
        `app:${appId}`,
        "warn",
        `[licensing] app ${appId} has no readable document; holding all its licences and environments`,
      );
      return;
    }
    if (app.tampered) {
      this.notices.note(
        `app:${appId}`,
        "error",
        `[licensing] app ${appId} is TAMPERED (${app.tamperReason ?? "unknown"}); holding all its licences and environments`,
      );
    }
    const environments = await this.timed(this.d.environments(appId), `environments of app ${appId}`);
    const resolve = (kind: string | null): PlanResolution => {
      const r = resolveKind(app, kind);
      return r.ok
        ? {
            ok: true,
            mode: r.template.mode,
            templateId: r.template.id,
            templateHash: r.template.templateHash,
            sharedStage: r.stage,
            label: r.label,
          }
        : r;
    };
    const planned = planChains({
      licences,
      environments: environments.map((e) => ({
        environmentId: e.environment_id,
        rootLicenseId: e.root_license_id,
        licenseId: e.license_id,
        templateHash: e.template_hash,
        endedAt: e.ended_at,
      })),
      resolve,
      app: { tampered: app.tampered, tamperReason: app.tamperReason, unverified: app.unverified },
      // The migration seeds the ledger; from then on an app without a row is
      // not one the system wrote, and is held.
      holdUnverified: true,
    });
    const steps = this.holdChains(planned, licences, heldRoots);
    const held = app.tampered || app.unverified;
    this.noteHoldsAndAnomalies(appId, steps);

    const envById = new Map(environments.map((e) => [e.environment_id, e]));
    const provisionKind = (step: Extract<ChainStep, { kind: "provision" }>): ProvisionKind => {
      const env = step.environmentId === null ? undefined : envById.get(step.environmentId);
      if (!env || env.template_hash === UNAPPLIED_TEMPLATE_HASH) return "create";
      return env.template_hash === step.templateHash ? "repoint" : "retemplate";
    };

    if (this.d.cfg.dryRun) {
      const count = (k: ChainStep["kind"]) => steps.filter((s) => s.kind === k).length;
      const provisions = steps.flatMap((s) => (s.kind === "provision" ? [provisionKind(s)] : []));
      const of = (k: ProvisionKind) => provisions.filter((p) => p === k).length;
      this.notices.note(
        `app:${appId}:dry-run`,
        "info",
        `[licensing] dry run: app ${appId} would create ${of("create")}, retemplate ${of("retemplate")}, repoint ${of("repoint")}, set-stage ${count("set-stage")}, end ${count("ended")}, resume ${count("resumed")}; holding ${count("hold")}`,
      );
      return;
    }

    const rootById = new Map(licences.map((l) => [l.id, l.root]));
    const groups = new Map<string, ChainStep[]>();
    for (const step of steps) {
      const root =
        rootOfStep(step, rootById) ?? (step.kind === "set-stage" ? step.licenseId : "");
      groups.set(root, [...(groups.get(root) ?? []), step]);
    }
    const confirmedEnded = new Set<string>();
    for (const [root, group] of rotate([...groups], this.tickNo)) {
      if (await this.runChain(app, root, group, provisionKind)) confirmedEnded.add(root);
    }
    if (!held) {
      const after = await this.timed(this.d.environments(appId), `environments of app ${appId}`);
      for (const row of after) {
        if (row.ended_at === null || confirmedEnded.has(row.root_license_id)) continue;
        this.notices.note(
          `frozen:${row.environment_id}`,
          "warn",
          `[licensing] offboarding of environment ${row.environment_id} (chain ${row.root_license_id}) is frozen: this tick did not confirm the chain as ended`,
        );
      }
      await this.timed(
        this.d.afterApp(appId, after, confirmedEnded),
        `after-app work of app ${appId}`,
      );
    }
  }

  /**
   * One chain's steps, in order, stopping at the first failure. A chain whose
   * step is still running (it timed out earlier) is skipped until that step
   * settles; a chain that failed is skipped for 1, 2, 4… ticks (at most
   * BACKOFF_CAP_TICKS), reset by a tick on which it succeeds.
   * Returns true only when the chain was confirmed ended this tick: it has an
   * ended / still-ended step and every step settled.
   */
  private async runChain(
    app: AppDocView,
    root: string,
    steps: ChainStep[],
    provisionKind: (step: Extract<ChainStep, { kind: "provision" }>) => ProvisionKind,
  ): Promise<boolean> {
    const appId = app.id;
    const key = `${appId}:${root}`;
    if (!steps.some((s) => s.kind !== "hold" && s.kind !== "anomaly")) return false;
    if (this.inFlight.has(key)) {
      this.notices.note(
        `inflight:${key}`,
        "info",
        `[licensing] chain ${root} of app ${appId}: a step from an earlier tick is still running; skipping`,
      );
      return false;
    }
    const backoff = this.backoff.get(key);
    if (backoff && this.tickNo <= backoff.until) {
      this.notices.note(
        `backoff:${key}`,
        "info",
        `[licensing] chain ${root} of app ${appId} failed ${backoff.failures} time(s) in a row; retrying on tick ${backoff.until + 1}`,
      );
      return false;
    }
    for (const step of steps) {
      let budgeted = false;
      if (step.kind === "provision" && provisionKind(step) === "retemplate") {
        if (this.retemplateBudget <= 0) {
          this.deferredRetemplates++;
          return false; // not a failure: the chain waits its turn
        }
        this.retemplateBudget--;
        budgeted = true;
      }
      const running = this.apply(app, step);
      this.inFlight.add(key);
      const settled = () => this.inFlight.delete(key);
      void running.then(settled, settled);
      try {
        await this.timed(running, `${step.kind} of ${root} (app ${appId})`);
      } catch (err) {
        // Refused before anything was dispatched: the budget was not spent.
        if (
          budgeted &&
          (err instanceof EnvironmentNotReadyError || err instanceof EnvironmentOwnershipMismatchError)
        ) {
          this.retemplateBudget++;
        }
        const failures = (backoff?.failures ?? 0) + 1;
        const skip = Math.min(2 ** (failures - 1), BACKOFF_CAP_TICKS);
        this.backoff.set(key, { failures, until: this.tickNo + skip });
        this.notices.note(
          `step:${key}:${step.kind}`,
          "warn",
          `[licensing] ${step.kind} of ${root} for app ${appId} failed: ${String(err)}`,
        );
        return false;
      }
    }
    this.backoff.delete(key);
    return steps.some((s) => s.kind === "ended" || s.kind === "still-ended");
  }

  private noteHoldsAndAnomalies(appId: string, steps: ChainStep[]): void {
    const anomalies = new Map<string, string[]>();
    for (const step of steps) {
      if (step.kind === "hold") {
        this.notices.note(
          `chain:${appId}:${step.root}:hold`,
          "warn",
          `[licensing] holding chain ${step.root} of app ${appId}: ${step.reason}`,
        );
      } else if (step.kind === "anomaly") {
        anomalies.set(step.root, [...(anomalies.get(step.root) ?? []), step.reason]);
      }
    }
    for (const [root, reasons] of anomalies) {
      this.notices.note(
        `chain:${appId}:${root}:anomaly`,
        "warn",
        `[licensing] chain ${root} of app ${appId}: ${reasons.join("; ")}`,
      );
    }
  }

  /** Replaces every step of a held chain by one hold. */
  private holdChains(
    steps: ChainStep[],
    licences: PlanLicence[],
    heldRoots: Map<string, string>,
  ): ChainStep[] {
    if (heldRoots.size === 0) return steps;
    const rootById = new Map(licences.map((l) => [l.id, l.root]));
    const out: ChainStep[] = [];
    const done = new Set<string>();
    for (const step of steps) {
      const root = rootOfStep(step, rootById);
      const reason = root === null ? undefined : heldRoots.get(root);
      if (root === null || reason === undefined) {
        out.push(step);
        continue;
      }
      if (done.has(root)) continue;
      done.add(root);
      out.push({ kind: "hold", root, reason });
    }
    return out;
  }

  private async apply(app: AppDocView, step: ChainStep): Promise<void> {
    switch (step.kind) {
      case "hold":
      case "anomaly":
      case "still-ended":
        return; // logged; never acted on
      case "set-stage":
        await this.d.setStage(step.licenseId, step.stage);
        return;
      case "ended":
        await this.d.onEnded(app.id, step.environmentId);
        return;
      case "resumed":
        await this.d.onResumed(app.id, step.environmentId);
        return;
      case "provision": {
        // The same app snapshot the plan resolved from: the planner only
        // emits a provision for a kind that resolved.
        const resolved = resolveKind(app, step.licence.kind);
        if (!resolved.ok) {
          throw new Error(`kind ${step.licence.kind ?? "(none)"} no longer resolves: ${resolved.reason}`);
        }
        const row = await this.d.provision({
          appId: app.id,
          root: step.root,
          licenseId: step.licence.id,
          userDid: step.licence.user,
          templateId: step.templateId,
          template: resolved.template.template,
          templateHash: step.templateHash,
          label: (await this.d.chainLabel(step.root)) ?? step.label,
          now: this.d.now(),
        });
        if (step.licence.stage !== row.environment_id) {
          await this.d.setStage(step.licence.id, row.environment_id);
        }
        return;
      }
    }
  }
}
