import type { LicensingConfig } from "./config.js";
import { computeLicensePlan, type ActiveLicense, type UserEnvironment } from "./plan.js";
import type { LicenseFullRow } from "./reads.js";
import type { LicenseTypeView } from "./resolvers.js";

export interface ProvisioningKeeperDeps {
  allLicenses(): Promise<LicenseFullRow[]>;
  licenseTypes(appId: string): Promise<LicenseTypeView[]>;
  environments(appId: string): Promise<UserEnvironment[]>;
  applyFor(appId: string, licence: ActiveLicense): Promise<void>;
  releaseFor(appId: string, environmentId: string): Promise<void>;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn">;
}

/**
 * Turns active licences into environments on a timer, and releases the
 * environments of licences that are no longer active. Same shape as
 * LicenseKeeper: the re-entrancy guard matters because a reconcile creates
 * environments and must not overlap itself.
 *
 * Every app that has any licence is visited, not only apps with an ACTIVE one:
 * the last licence of an app being revoked is exactly the case where its
 * environment has to be released.
 */
export class ProvisioningKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: ProvisioningKeeperDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err) =>
          this.d.logger.warn(
            `[licensing] provisioning tick failed: ${String(err)}`,
          ),
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

    const byApp = new Map<string, LicenseFullRow[]>();
    for (const row of await this.d.allLicenses()) {
      if (!row.app) {
        this.d.logger.warn(`[licensing] licence ${row.id} has no app; skipping`);
        continue;
      }
      const list = byApp.get(row.app) ?? [];
      list.push(row);
      byApp.set(row.app, list);
    }

    for (const [appId, rows] of byApp) {
      try {
        await this.reconcileApp(appId, rows);
      } catch (err) {
        this.d.logger.warn(
          `[licensing] reconcile of app ${appId} failed: ${String(err)}`,
        );
      }
    }
  }

  private async reconcileApp(
    appId: string,
    rows: LicenseFullRow[],
  ): Promise<void> {
    const hashes = new Map(
      (await this.d.licenseTypes(appId))
        .filter((t) => t.status !== "RETIRED")
        .map((t) => [t.id, t.templateHash]),
    );

    const actives: ActiveLicense[] = [];
    for (const row of rows) {
      if (row.status !== "ACTIVE") continue;
      const templateHash = hashes.get(row.licenseTypeId);
      if (templateHash === undefined) {
        this.d.logger.warn(
          `[licensing] licence ${row.id} of app ${appId} skipped: type ${row.licenseTypeId} is missing or retired`,
        );
        continue;
      }
      actives.push({
        licenseId: row.id,
        user: row.user,
        licenseTypeId: row.licenseTypeId,
        templateHash,
      });
    }

    const plan = computeLicensePlan(actives, await this.d.environments(appId));

    if (this.d.cfg.dryRun) {
      this.d.logger.info(
        `[licensing] dry run: app ${appId} would apply ${plan.toApply.length}, release ${plan.toRelease.length}`,
      );
      return;
    }

    for (const licence of plan.toApply) {
      try {
        await this.d.applyFor(appId, licence);
      } catch (err) {
        this.d.logger.warn(
          `[licensing] apply ${licence.licenseId} failed: ${String(err)}`,
        );
      }
    }
    for (const environmentId of plan.toRelease) {
      try {
        await this.d.releaseFor(appId, environmentId);
      } catch (err) {
        this.d.logger.warn(
          `[licensing] release ${environmentId} failed: ${String(err)}`,
        );
      }
    }
  }
}
