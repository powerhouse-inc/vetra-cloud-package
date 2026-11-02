import type { AppDocView, AppReads } from "./app-reads.js";
import type { WarmEnvInput } from "./warm-env.js";
import type { WarmPoolStore, WarmRow } from "./warm-pool-db.js";
import { computeAppPoolPlan, type PoolTarget } from "./warm-pool-plan.js";

export interface WarmPoolKeeperConfig {
  /** LICENSING_KEEPER_ENABLED: off, the keeper does nothing. */
  enabled: boolean;
  /** LICENSING_DRY_RUN: plans are logged, nothing is written. */
  dryRun: boolean;
  scanIntervalMs: number;
  /** Creations per tick across all pools; a failed attempt counts. */
  createsPerTick: number;
  maxPerTemplate: number;
}

export interface WarmPoolKeeperDeps {
  /** The trusted app ids (an apps row, or the studio app). */
  appIds(): Promise<string[]>;
  apps: Pick<AppReads, "app">;
  store: Pick<
    WarmPoolStore,
    "allLive" | "markAvailable" | "markDeletedUnclaimed"
  >;
  /** The environment document's status; null when the document is missing. */
  envStatus(environmentId: string): Promise<string | null>;
  deleteEnv(environmentId: string): Promise<void>;
  /** createWarmEnvironment with its dependencies bound. */
  createWarm(input: WarmEnvInput): Promise<string>;
  now(): string;
  logger: { info(m: string): void; warn(m: string): void };
}

/** App document statuses whose pools are drained. */
const SUSPENDED_APP_STATUSES = new Set(["DISCONNECTED", "DELETED"]);

const poolKey = (appId: string, templateId: string) =>
  `${appId}\u0000${templateId}`;

interface Pool {
  appId: string;
  templateId: string;
  /** null drains the pool. */
  target: PoolTarget | null;
  rows: WarmRow[];
}

/**
 * Keeps every app's warm pools filled and on the template's current release:
 * one pool per (app, DEDICATED template) with warmPoolSize > 0 on an app that
 * is not suspended and has an ACTIVE term on that template. Pools that no
 * longer qualify but still have live rows are drained. An app that is
 * tampered or unverified, or a template that does not resolve, is held: its
 * pool is left exactly as it is. CLAIMED rows belong to licences and are
 * never touched.
 *
 * In-process `running` guard: the licensing subgraph is single-replica.
 */
export class AppWarmPoolKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly d: WarmPoolKeeperDeps,
    private readonly cfg: WarmPoolKeeperConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.reconcileOnce().catch((err: unknown) =>
        this.d.logger.warn(`[warm-pool] keeper tick failed: ${String(err)}`),
      );
    };
    tick();
    this.timer = setInterval(tick, this.cfg.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileOnce(): Promise<void> {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;
    try {
      await this.tick();
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    const [ids, live] = await Promise.all([
      this.d.appIds(),
      this.d.store.allLive(),
    ]);
    const pools = new Map<string, Pool>();
    const held = new Set<string>();
    const heldApps = new Set<string>();

    for (const id of ids) {
      let app: AppDocView | null;
      try {
        app = await this.d.apps.app(id);
      } catch (err) {
        this.d.logger.warn(
          `[warm-pool] app ${id} unreadable; holding its pools: ${String(err)}`,
        );
        heldApps.add(id);
        continue;
      }
      if (!app) continue;
      if (app.tampered || app.unverified) {
        heldApps.add(id);
        continue;
      }
      if (SUSPENDED_APP_STATUSES.has(app.status)) continue;
      for (const t of app.templates) {
        if (t.mode !== "DEDICATED" || t.warmPoolSize <= 0) continue;
        if (
          !app.terms.some(
            (term) => term.templateId === t.id && term.status === "ACTIVE",
          )
        )
          continue;
        const key = poolKey(app.id, t.id);
        if (t.resolutionError) {
          held.add(key);
          continue;
        }
        pools.set(key, {
          appId: app.id,
          templateId: t.id,
          rows: [],
          target: {
            appId: app.id,
            appName: app.name ?? app.slug ?? app.id,
            templateId: t.id,
            templateHash: t.templateHash,
            size: t.warmPoolSize,
            template: t.template,
          },
        });
      }
    }

    for (const r of live) {
      const key = poolKey(r.app_id, r.template_id);
      if (held.has(key) || heldApps.has(r.app_id)) continue;
      const pool = pools.get(key) ?? {
        appId: r.app_id,
        templateId: r.template_id,
        target: null,
        rows: [],
      };
      pool.rows.push(r);
      pools.set(key, pool);
    }

    let budget = this.cfg.createsPerTick;
    for (const pool of pools.values()) {
      try {
        budget -= await this.reconcilePool(pool, budget);
      } catch (err) {
        this.d.logger.warn(
          `[warm-pool] pool ${pool.appId}/${pool.templateId} failed: ${String(err)}`,
        );
      }
    }
  }

  /** Applies one pool's plan; returns how many creations it attempted. */
  private async reconcilePool(pool: Pool, budget: number): Promise<number> {
    const label = `${pool.appId}/${pool.templateId}`;
    const status: Record<string, string | null> = {};
    if (pool.target) {
      for (const r of pool.rows) {
        if (r.state === "CLAIMED") continue;
        status[r.environment_id] = await this.d.envStatus(r.environment_id);
      }
    }
    const plan = computeAppPoolPlan(
      pool.rows,
      pool.target,
      status,
      this.cfg.maxPerTemplate,
    );
    if (
      plan.create === 0 &&
      plan.promote.length === 0 &&
      plan.remove.length === 0
    )
      return 0;

    if (this.cfg.dryRun) {
      this.d.logger.info(
        `[warm-pool] dry run: pool ${label} would promote ${plan.promote.length}, remove ${plan.remove.length}, create ${plan.create}`,
      );
      return 0;
    }

    for (const id of plan.promote) {
      await this.d.store.markAvailable(id, this.d.now());
      this.d.logger.info(`[warm-pool] ${label}: ${id} is AVAILABLE`);
    }

    for (const id of plan.remove) {
      // Retire the row first: a claim that won the race keeps its environment.
      if (!(await this.d.store.markDeletedUnclaimed(id, this.d.now())))
        continue;
      try {
        await this.d.deleteEnv(id);
        this.d.logger.info(`[warm-pool] ${label}: removed ${id}`);
      } catch (err) {
        this.d.logger.warn(
          `[warm-pool] ${label}: could not delete environment ${id}; it is orphaned: ${String(err)}`,
        );
      }
    }

    const target = pool.target;
    if (!target) return 0;
    const attempts = Math.min(plan.create, Math.max(0, budget));
    for (let i = 0; i < attempts; i++) {
      try {
        const id = await this.d.createWarm({
          appId: target.appId,
          appName: target.appName,
          template: { ...target.template, id: target.templateId },
          templateHash: target.templateHash,
          nowIso: this.d.now(),
        });
        this.d.logger.info(`[warm-pool] ${label}: warming ${id}`);
      } catch (err) {
        this.d.logger.warn(
          `[warm-pool] ${label}: create failed: ${String(err)}`,
        );
        return i + 1;
      }
    }
    return attempts;
  }
}
