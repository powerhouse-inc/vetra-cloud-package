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
import type { ProvisionChainInput } from "./environments.js";
import type { GrantProvenance } from "./grants.js";
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
  /** Runs after an app's steps (offboarding ticks, reporting tokens); never for a held app. */
  afterApp(appId: string, environments: LicenseEnvironments[]): Promise<void>;
  /** True once the startup migration recorded `complete`. */
  migrationComplete(): Promise<boolean>;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn" | "error">;
  now(): string;
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

const rootOfStep = (step: ChainStep, rootById: Map<string, string>): string | null =>
  step.kind === "set-stage" ? (rootById.get(step.licenseId) ?? null) : step.root;

/**
 * AppLicenseHandler: licence -> app.terms[kind] -> app.templates[templateId]
 * -> by mode. Timer-driven, re-entrancy guarded, every app (and every step)
 * isolated from every other's failures.
 *
 * It never stops, releases or deletes an environment: an ended chain is only
 * reported (onEnded). Anything it cannot be sure of — the migration not yet
 * complete, an unreadable or tampered app, a licence without provenance or
 * disagreeing with it, an unreadable chain member — is held and logged.
 */
export class AppLicenseHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: HandlerDeps) {}

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
    // Before the migration, license_environments is empty while live
    // environments exist: planning now would provision a second environment
    // for every live holder.
    if (!(await this.d.migrationComplete())) {
      this.d.logger.info(
        "[licensing] handler idle: waiting for the licensing migration to complete",
      );
      return;
    }

    const [licences, roots, grants] = await Promise.all([
      this.d.licences(),
      this.d.chainRoots(),
      this.d.grants(),
    ]);
    const byApp = new Map<string, PlanLicence[]>();
    const add = (appId: string, l: PlanLicence) => {
      const list = byApp.get(appId) ?? [];
      list.push(l);
      byApp.set(appId, list);
    };
    const read = new Set<string>();
    for (const l of licences) {
      read.add(l.id);
      const grant = grants.get(l.id);
      let user = l.user;
      let usable = true;
      try {
        user = normaliseUserDid(l.user);
      } catch {
        usable = false;
        // Kept in its chain, unauthorised: dropping it could leave only
        // terminal siblings, which would read as an ended chain.
        this.d.logger.warn(
          `[licensing] licence ${l.id} has an unusable holder ${l.user}; holding its chain`,
        );
      }
      const why = unauthorisedBecause(l, grant);
      if (why && grant && usable) {
        this.d.logger.warn(`[licensing] licence ${l.id} ${why}; holding its chain`);
      }
      // The grant's app is authoritative: a licence document claiming another
      // app is planned (unauthorised) where its grant says it belongs.
      add(grant?.appId ?? l.app, {
        id: l.id,
        user,
        kind: l.kind,
        status: l.status,
        issued: isoOrNull(l.issued ?? l.start),
        stage: l.stage,
        root: roots.get(l.id) ?? l.id,
        authorised: why === null,
        replacedBy: l.replacedBy,
      });
    }

    // Authorised licences whose document could not be read: their chain's
    // state is unknown, never ended.
    const unreadable = new Map<string, Map<string, string>>();
    for (const [id, grant] of grants) {
      if (read.has(id)) continue;
      const perApp = unreadable.get(grant.appId) ?? new Map<string, string>();
      perApp.set(roots.get(id) ?? id, id);
      unreadable.set(grant.appId, perApp);
    }

    for (const appId of await this.d.environmentAppIds()) {
      if (!byApp.has(appId)) byApp.set(appId, []);
    }

    for (const [appId, appLicences] of byApp) {
      try {
        await this.reconcileApp(appId, appLicences, unreadable.get(appId) ?? new Map<string, string>());
      } catch (err) {
        this.d.logger.warn(`[licensing] reconcile of app ${appId} failed: ${String(err)}`);
      }
    }
  }

  private async reconcileApp(
    appId: string,
    licences: PlanLicence[],
    unreadableRoots: Map<string, string>,
  ): Promise<void> {
    const app = await this.d.app(appId);
    if (!app) {
      this.d.logger.warn(
        `[licensing] app ${appId} has no readable document; holding all its licences and environments`,
      );
      return;
    }
    if (app.tampered) {
      this.d.logger.error(
        `[licensing] app ${appId} is TAMPERED (${app.tamperReason ?? "unknown"}); holding all its licences and environments`,
      );
    }
    const environments = await this.d.environments(appId);
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
    const steps = this.holdUnreadable(planned, licences, unreadableRoots);
    const held = app.tampered || app.unverified;

    for (const step of steps) {
      if (step.kind === "hold") {
        this.d.logger.warn(`[licensing] holding chain ${step.root} of app ${appId}: ${step.reason}`);
      } else if (step.kind === "anomaly") {
        this.d.logger.warn(`[licensing] chain ${step.root} of app ${appId}: ${step.reason}`);
      }
    }

    if (this.d.cfg.dryRun) {
      const count = (k: ChainStep["kind"]) => steps.filter((s) => s.kind === k).length;
      this.d.logger.info(
        `[licensing] dry run: app ${appId} would provision ${count("provision")}, set-stage ${count("set-stage")}, end ${count("ended")}, resume ${count("resumed")}; holding ${count("hold")}`,
      );
      return;
    }

    for (const step of steps) {
      try {
        await this.apply(app, step);
      } catch (err) {
        this.d.logger.warn(`[licensing] ${step.kind} for app ${appId} failed: ${String(err)}`);
      }
    }
    if (!held) await this.d.afterApp(appId, await this.d.environments(appId));
  }

  /** Replaces every step of a chain with an unreadable authorised member by one hold. */
  private holdUnreadable(
    steps: ChainStep[],
    licences: PlanLicence[],
    unreadableRoots: Map<string, string>,
  ): ChainStep[] {
    if (unreadableRoots.size === 0) return steps;
    const rootById = new Map(licences.map((l) => [l.id, l.root]));
    const out: ChainStep[] = [];
    const heldRoots = new Set<string>();
    for (const step of steps) {
      const root = rootOfStep(step, rootById);
      const missing = root === null ? undefined : unreadableRoots.get(root);
      if (root === null || missing === undefined) {
        out.push(step);
        continue;
      }
      if (heldRoots.has(root)) continue;
      heldRoots.add(root);
      out.push({
        kind: "hold",
        root,
        reason: `licence ${missing} has provenance but its document could not be read`,
      });
    }
    return out;
  }

  private async apply(app: AppDocView, step: ChainStep): Promise<void> {
    switch (step.kind) {
      case "hold":
      case "anomaly":
        return; // logged above; never acted on
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
        if (!resolved.ok) throw new Error(`kind ${step.licence.kind ?? "(none)"} no longer resolves: ${resolved.reason}`);
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
