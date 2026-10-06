import { computeLicensePlan, type ActiveLicense } from "../plan.js";

// The slice of the vetraLicensing GraphQL API this handler calls. Wire each
// method to the query or mutation of the same name.
export interface LicensingClient {
  appLicenses(args: { status: string }): Promise<
    { id: string; user: string; licenseTypeId: string; status: string }[]
  >;
  appLicenseTypes(): Promise<
    { id: string; kind: string; status: string; templateHash: string }[]
  >;
  appUserEnvironments(): Promise<
    { user: string; environmentId: string; templateHash: string }[]
  >;
  applyEnvironmentTemplate(input: {
    licenseId: string;
    label: string;
  }): Promise<{ environmentId: string }>;
  releaseEnvironment(input: { environmentId: string }): Promise<boolean>;
}

export interface LicenseHandlerConfig {
  /**
   * Log the plan and change nothing. Defaults to true: read a few ticks of
   * "would apply / would release" before you let this handler act. Set
   * `{ dryRun: false }` when the plan it logs is the one you want.
   */
  dryRun: boolean;
}

/**
 * Reconciles active licences against existing environments. Call
 * `reconcileOnce()` from a timer. It keeps no state between runs, so it heals
 * itself after any failure and is safe to run as often as you like:
 * applyEnvironmentTemplate is an upsert keyed on (app, user).
 *
 * Edit this file only if "every active licence gets its type's template" is not
 * the rule you want.
 */
export class LicenseHandler {
  constructor(
    private readonly client: LicensingClient,
    private readonly logger: Pick<Console, "info" | "warn">,
    private readonly config: LicenseHandlerConfig = { dryRun: true },
  ) {}

  async reconcileOnce(): Promise<void> {
    const [licenses, types, environments] = await Promise.all([
      this.client.appLicenses({ status: "ACTIVE" }),
      this.client.appLicenseTypes(),
      this.client.appUserEnvironments(),
    ]);

    // A retired or missing type has no usable template. Such a licence is left
    // out of the desired set, and so is its user's environment: otherwise no
    // licence would appear to justify that environment and it would be released.
    const usable = new Map(
      types.filter((t) => t.status === "ACTIVE").map((t) => [t.id, t]),
    );

    const active: ActiveLicense[] = [];
    // Addresses are compared lowercased throughout: a licence document may
    // carry a checksummed address while the environment table stores it
    // lowercased, and the two must still be the same user.
    const parked = new Set<string>();
    for (const l of licenses) {
      const type = usable.get(l.licenseTypeId);
      if (!type) {
        parked.add(l.user.toLowerCase());
        this.logger.warn(
          `[license-handler] licence ${l.id} points at unusable type ${l.licenseTypeId}; skipping`,
        );
        continue;
      }
      active.push({
        licenseId: l.id,
        user: l.user,
        licenseTypeId: l.licenseTypeId,
        templateHash: type.templateHash,
      });
    }

    const plan = computeLicensePlan(
      active,
      environments.filter((e) => !parked.has(e.user.toLowerCase())),
    );

    if (this.config.dryRun) {
      this.logger.info(
        `[license-handler] dry run: would apply ${plan.toApply
          .map((l) => l.licenseId)
          .join(", ")} and release ${plan.toRelease.join(", ")}`,
      );
      return;
    }

    for (const l of plan.toApply) {
      // Every licence in the plan came from `active`, which only holds licences
      // whose type is in `usable`, so this lookup always finds one.
      const type = usable.get(l.licenseTypeId)!;
      try {
        await this.client.applyEnvironmentTemplate({
          licenseId: l.licenseId,
          label: type.kind,
        });
      } catch (err) {
        this.logger.warn(
          `[license-handler] apply for ${l.licenseId} failed: ${String(err)}`,
        );
      }
    }

    for (const environmentId of plan.toRelease) {
      try {
        await this.client.releaseEnvironment({ environmentId });
      } catch (err) {
        this.logger.warn(
          `[license-handler] release of ${environmentId} failed: ${String(err)}`,
        );
      }
    }
  }
}
