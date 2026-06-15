import { computePoolPlan } from "./reconcile.js";
import type { KeeperDb } from "./pool-db.js";
import type { CreatedStudioEnv } from "./create-env.js";
import type { PoolConfig } from "./config.js";

export interface KeeperLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export interface KeeperDeps {
  db: KeeperDb;
  createEnv: () => Promise<CreatedStudioEnv>;
  terminate: (documentId: string) => Promise<void>;
  cfg: PoolConfig;
  logger: KeeperLogger;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * In-process worker that keeps `cfg.size` warm envs AVAILABLE. Runs inside the
 * Switchboard reactor (a subgraph starts it in onSetup), so it creates envs via
 * the reactor client directly — no wallet, no separate service.
 */
export class PoolKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly d: KeeperDeps,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.reconcileOnce().catch((err) =>
        this.d.logger.warn(`[studio-pool] keeper tick failed: ${String(err)}`),
      );
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileOnce(): Promise<void> {
    if (!this.d.cfg.enabled) return;

    // 1. Promote any warm env the observability reconciler drove to READY.
    await this.d.db.promoteReadyToAvailable();

    // 2. Plan from current rows.
    const rows = await this.d.db.listPoolRows();
    const plan = computePoolPlan(rows, {
      size: this.d.cfg.size,
      version: this.d.cfg.version,
    });

    // 3. Clear zombies: pool rows whose env is dead (terminated/recycled/failed)
    //    so they stop counting and can't be claimed.
    if (plan.toClear.length > 0) {
      try {
        await this.d.db.clearPoolState(plan.toClear);
        this.d.logger.info(
          `[studio-pool] cleared ${plan.toClear.length} dead pool row(s)`,
        );
      } catch (err) {
        this.d.logger.warn(`[studio-pool] clear failed: ${String(err)}`);
      }
    }

    // 4. Recycle stale-version unclaimed envs (terminate; next tick clears them).
    for (const id of plan.toRecycle) {
      try {
        await this.d.terminate(id);
        this.d.logger.info(`[studio-pool] recycled stale env ${id}`);
      } catch (err) {
        this.d.logger.warn(`[studio-pool] recycle ${id} failed: ${String(err)}`);
      }
    }

    // 5. Create the deficit; seed each new doc as WARMING. If the doc was
    //    created but seeding fails, terminate the orphan so it can't leak a
    //    namespace/pod the pool no longer tracks.
    for (let i = 0; i < plan.toCreate; i++) {
      let created: CreatedStudioEnv;
      try {
        created = await this.d.createEnv();
      } catch (err) {
        this.d.logger.warn(`[studio-pool] create failed: ${String(err)}`);
        continue;
      }
      try {
        await this.d.db.seedWarming({
          id: created.documentId,
          subdomain: created.subdomain,
          tenantId: created.tenantId,
          pinnedVersion: this.d.cfg.version,
        });
        this.d.logger.info(
          `[studio-pool] warming ${created.documentId} (${created.tenantId})`,
        );
      } catch (err) {
        this.d.logger.warn(
          `[studio-pool] seed failed for ${created.documentId}; terminating orphan: ${String(err)}`,
        );
        await this.d.terminate(created.documentId).catch(() => {});
      }
    }
  }
}
