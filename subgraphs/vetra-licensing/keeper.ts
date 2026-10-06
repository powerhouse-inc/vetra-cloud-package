import { computeLicenseTransitions, type LicenseRow } from "./transitions.js";
import type { LicensingConfig } from "./config.js";

export interface KeeperDeps {
  listLicenses(): Promise<LicenseRow[]>;
  activate(id: string): Promise<void>;
  expire(id: string): Promise<void>;
  now(): string;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn">;
}

/**
 * Moves licences through their lifecycle on a timer. Copies HousekeepingKeeper
 * rather than PoolKeeper: the re-entrancy guard matters here because a slow
 * reconcile must not overlap itself.
 */
export class LicenseKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: KeeperDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err) =>
          this.d.logger.warn(`[licensing] keeper tick failed: ${String(err)}`),
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

    const rows = await this.d.listLicenses();
    const plan = computeLicenseTransitions(rows, this.d.now());

    if (this.d.cfg.dryRun) {
      this.d.logger.info(
        `[licensing] dry run: would activate ${plan.toActivate.length}, expire ${plan.toExpire.length}`,
      );
      return;
    }

    for (const id of plan.toActivate) {
      try {
        await this.d.activate(id);
      } catch (err) {
        this.d.logger.warn(`[licensing] activate ${id} failed: ${String(err)}`);
      }
    }
    for (const id of plan.toExpire) {
      try {
        await this.d.expire(id);
      } catch (err) {
        this.d.logger.warn(`[licensing] expire ${id} failed: ${String(err)}`);
      }
    }
  }
}
