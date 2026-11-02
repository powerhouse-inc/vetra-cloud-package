import type { AppDocView, AppReads } from "./app-reads.js";
import type { WarmEnvInput } from "./warm-env.js";
import type { WarmPoolStore, WarmRow } from "./warm-pool-db.js";
import {
  computeAppPoolPlan,
  MAX_WARMING_MS,
  type PoolTarget,
} from "./warm-pool-plan.js";
import { DEAD_STATUSES } from "../vetra-studio-pool/reconcile.js";

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
    | "allLive"
    | "markAvailable"
    | "markDeletedUnclaimed"
    | "awaitingDeletion"
    | "markEnvDeleted"
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

/**
 * A refused deletion is logged at its first failure and then every this many
 * (one per tick otherwise); the dry-run sweep line likewise, unless its set
 * changes.
 */
const SWEEP_LOG_EVERY = 20;

/** stop() warns (once) when the tick in flight takes longer than this. */
const STOP_SLOW_WARN_MS = 30_000;

/** Creation backoff after a dead removal: 2, 4, 8, then 16 ticks. */
const BACKOFF_BASE_TICKS = 2;
const BACKOFF_MAX_TICKS = 16;

const poolKey = (appId: string, templateId: string) =>
  `${appId}\u0000${templateId}`;

interface Pool {
  key: string;
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
 * Fairness: each tick starts at a pool one further along than the last
 * (rotation), and a pool gets at most one creation per tick, within the
 * shared createsPerTick budget. A pool from which a dead environment (dead
 * status, missing document, or WARMING longer than MAX_WARMING_MS without
 * becoming READY, which is logged) was removed gets no creations for 2, 4, 8,
 * then 16 ticks (counting the tick of the removal); removal, promotion and
 * recycling still run. The backoff resets once a tick with no dead removal
 * finds the pool needing no creation with no row left WARMING (full and
 * healthy), so repeated timeouts escalate rather than restart at 2.
 *
 * In-process `running` guard: the licensing subgraph is single-replica.
 * stop() waits for the tick in flight, which stops at its next step.
 */
export class AppWarmPoolKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  /** Set by stop(): the tick in flight starts nothing more, later ones do nothing. */
  private stopped = false;
  private tickNo = 0;
  /**
   * Environment id -> consecutive failed deletions, for log throttling only:
   * a restart loses it and merely logs the next failure again. What is left
   * to delete is durable (the store's awaitingDeletion).
   */
  private readonly deleteFailures = new Map<string, number>();
  /** The dry-run sweep's last logged set and the dry-run ticks since. */
  private drySweep: { key: string; ticks: number } | null = null;
  /** Pool key -> consecutive dead-removal level and the last tick it may not create in. */
  private readonly backoff = new Map<
    string,
    { level: number; blockedThrough: number }
  >();

  constructor(
    private readonly d: WarmPoolKeeperDeps,
    private readonly cfg: WarmPoolKeeperConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => {
      this.reconcileOnce().catch((err: unknown) =>
        this.d.logger.warn(`[warm-pool] keeper tick failed: ${String(err)}`),
      );
    };
    tick();
    this.timer = setInterval(tick, this.cfg.scanIntervalMs);
  }

  /**
   * Stops the timer and resolves once the tick in flight (if any) has
   * finished: it stops before its next pool, creation or deletion, so no
   * create or delete runs after this resolves.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    const running = this.running;
    if (!running) return;
    // Keeps waiting (no create or delete may run after stop resolves), but
    // says so when a reactor call in the tick seems to hang.
    const slow = setTimeout(() => {
      this.d.logger.warn(
        `[warm-pool] stopping: the keeper tick is still running after ${STOP_SLOW_WARN_MS / 1000} s; still waiting for it`,
      );
    }, STOP_SLOW_WARN_MS);
    try {
      // A failed tick was already the tick's caller's to report; stop() (and
      // onDisconnect after it) must not throw for it.
      await running.catch(() => {});
    } finally {
      clearTimeout(slow);
    }
  }

  async reconcileOnce(): Promise<void> {
    if (!this.cfg.enabled || this.running || this.stopped) return;
    this.running = this.tick().finally(() => {
      this.running = null;
    });
    await this.running;
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
      if (this.stopped) return;
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
          key,
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
        key,
        appId: r.app_id,
        templateId: r.template_id,
        target: null,
        rows: [],
      };
      pool.rows.push(r);
      pools.set(key, pool);
    }

    const tickNo = ++this.tickNo;
    for (const key of [...this.backoff.keys()]) {
      if (!pools.has(key)) this.backoff.delete(key);
    }
    const list = [...pools.values()];
    const offset = list.length === 0 ? 0 : (tickNo - 1) % list.length;
    const rotated = [...list.slice(offset), ...list.slice(0, offset)];
    let budget = this.cfg.createsPerTick;
    const attempted = new Set<string>();
    for (const pool of rotated) {
      if (this.stopped) return;
      try {
        budget -= await this.reconcilePool(pool, budget, tickNo, attempted);
      } catch (err) {
        this.d.logger.warn(
          `[warm-pool] pool ${pool.appId}/${pool.templateId} failed: ${String(err)}`,
        );
      }
    }
    try {
      await this.sweep(attempted);
    } catch (err) {
      this.d.logger.warn(`[warm-pool] sweep failed: ${String(err)}`);
    }
  }

  /**
   * Deletes the environment of every retired row whose deletion failed
   * before (or never ran: a crash between retiring and deleting). A document
   * already gone counts as deleted. Durable: the rows say what is left.
   * `attempted`: deleted (or tried) earlier in this tick; not tried twice.
   */
  private async sweep(attempted: ReadonlySet<string>): Promise<void> {
    const rows = (await this.d.store.awaitingDeletion()).filter(
      (r) => !attempted.has(r.environment_id),
    );
    if (this.cfg.dryRun) {
      const key = rows.map((r) => r.environment_id).join(",");
      const ticks = this.drySweep?.key === key ? this.drySweep.ticks + 1 : 0;
      this.drySweep = { key, ticks: ticks % SWEEP_LOG_EVERY };
      if (rows.length > 0 && ticks % SWEEP_LOG_EVERY === 0) {
        this.d.logger.info(
          `[warm-pool] dry run: would delete ${rows.length} retired environment(s): ${key}`,
        );
      }
      return;
    }
    for (const r of rows) {
      if (this.stopped) return;
      const label = `${r.app_id}/${r.template_id}`;
      try {
        await this.deleteRetired(r.environment_id);
        this.d.logger.info(
          `[warm-pool] ${label}: deleted retired environment ${r.environment_id}`,
        );
      } catch (err) {
        const n = this.deleteFailed(r.environment_id);
        if ((n - 1) % SWEEP_LOG_EVERY === 0) {
          this.d.logger.warn(
            `[warm-pool] ${label}: retired environment ${r.environment_id} still not deleted after ${n} attempts; it will be retried: ${String(err)}`,
          );
        }
      }
    }
  }

  /** Deletes a retired row's environment and records it; throws when it is still there. */
  private async deleteRetired(id: string): Promise<void> {
    try {
      await this.d.deleteEnv(id);
    } catch (err) {
      // Already gone is what we wanted.
      if ((await this.d.envStatus(id)) !== null) throw err;
    }
    this.deleteFailures.delete(id);
    await this.d.store.markEnvDeleted(id, this.d.now());
  }

  /** Counts a failed deletion of `id`; returns how many in a row. */
  private deleteFailed(id: string): number {
    const n = (this.deleteFailures.get(id) ?? 0) + 1;
    this.deleteFailures.set(id, n);
    return n;
  }

  /** Applies one pool's plan; returns how many creations it attempted. */
  private async reconcilePool(
    pool: Pool,
    budget: number,
    tickNo: number,
    attempted: Set<string>,
  ): Promise<number> {
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
      this.d.now(),
    );
    // A row still WARMING has not proven the template healthy: until it is
    // READY (or retired) the backoff stands, or every timeout would restart it.
    const settled = !pool.rows.some(
      (r) =>
        r.state === "WARMING" &&
        !plan.promote.includes(r.environment_id) &&
        !plan.remove.includes(r.environment_id),
    );
    if (
      plan.create === 0 &&
      plan.promote.length === 0 &&
      plan.remove.length === 0
    ) {
      // Full and healthy: any creation backoff is over.
      if (settled) this.backoff.delete(pool.key);
      return 0;
    }

    if (this.cfg.dryRun) {
      this.d.logger.info(
        `[warm-pool] dry run: pool ${label} would promote ${plan.promote.length}, remove ${plan.remove.length}, create ${plan.create}`,
      );
      return 0;
    }

    for (const id of plan.promote) {
      if (this.stopped) return 0;
      await this.d.store.markAvailable(id, this.d.now());
      this.d.logger.info(`[warm-pool] ${label}: ${id} is AVAILABLE`);
    }

    for (const id of plan.timedOut) {
      this.d.logger.warn(
        `[warm-pool] ${label}: ${id} is still WARMING (environment ${status[id] ?? "missing"}) after more than ${MAX_WARMING_MS / 60_000} minutes; retiring it`,
      );
    }

    for (const id of plan.remove) {
      if (this.stopped) return 0;
      // Retire the row first: a claim that won the race keeps its environment.
      if (!(await this.d.store.markDeletedUnclaimed(id, this.d.now())))
        continue;
      attempted.add(id);
      try {
        await this.deleteRetired(id);
        this.d.logger.info(`[warm-pool] ${label}: removed ${id}`);
      } catch (err) {
        this.deleteFailed(id);
        this.d.logger.warn(
          `[warm-pool] ${label}: could not delete environment ${id}; its retired row keeps it to be retried: ${String(err)}`,
        );
      }
    }

    const target = pool.target;
    if (!target) return 0;
    // Every unclaimed row of a targeted pool has its status read above.
    // A dead or missing environment, or a warm-up that timed out: a failure
    // that backs the pool's creation off.
    const timedOut = new Set(plan.timedOut);
    const dead = plan.remove.some((id) => {
      const st = status[id];
      return st === null || DEAD_STATUSES.has(st) || timedOut.has(id);
    });
    if (!this.mayCreate(pool.key, dead, plan.create, settled, tickNo)) {
      if (plan.create > 0) {
        this.d.logger.info(
          `[warm-pool] ${label}: creation backed off after a dead or timed-out environment`,
        );
      }
      return 0;
    }
    // At most one creation per pool per tick.
    const attempts = Math.min(plan.create, 1, Math.max(0, budget));
    for (let i = 0; i < attempts; i++) {
      if (this.stopped) return i;
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

  /** Updates the pool's backoff for this tick; true when it may create. */
  private mayCreate(
    key: string,
    dead: boolean,
    create: number,
    settled: boolean,
    tickNo: number,
  ): boolean {
    const prev = this.backoff.get(key);
    if (dead) {
      const level = (prev?.level ?? 0) + 1;
      const wait = Math.min(BACKOFF_BASE_TICKS ** level, BACKOFF_MAX_TICKS);
      this.backoff.set(key, { level, blockedThrough: tickNo + wait });
      return false;
    }
    if (!prev) return true;
    if (create === 0) {
      if (settled) this.backoff.delete(key);
      return true;
    }
    return tickNo > prev.blockedThrough;
  }
}
