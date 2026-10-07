import type { Kysely } from "kysely";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";
import { resolveCallerApp, type AuthContext, type AuthDeps } from "./auth.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "./provision.js";
import { releaseEnvironment, type ReleaseDeps } from "./release.js";
import { issuePublisherGrant, type GrantDeps } from "./issuers/publisher-grant.js";
import { createEnvironmentRows } from "./rows.js";
import type { LicensingConfig } from "./config.js";
import type { TemplateShape } from "./template.js";

export interface LicenseView {
  id: string;
  user: string;
  licenseTypeId: string;
  status: string;
  start: string | null;
  end: string | null;
}

export interface LicenseTypeView {
  id: string;
  kind: string;
  status: string;
  templateHash: string;
}

export interface ResolverDeps {
  auth: AuthDeps;
  provision: Omit<
    ProvisionDeps,
    "findRow" | "countForApp" | "maxForApp" | "claimRow" | "upsertRow"
  >;
  release: ReleaseDeps;
  grant: GrantDeps;
  cfg: LicensingConfig;
  /** Reads licence and licence-type documents. Every read is scoped to one app. */
  read: {
    licenses(appId: string, status: string | null): Promise<LicenseView[]>;
    licenseTypes(appId: string): Promise<LicenseTypeView[]>;
    /** null when the licence type is missing or RETIRED. */
    templateFor(licenseId: string): Promise<TemplateShape | null>;
  };
}

/**
 * Thrown by every write when licensing is switched off for this deployment.
 * Reads are never gated, so an operator can still inspect licences and
 * environments on a deployment where the feature is off.
 */
export class LicensingDisabledError extends Error {
  override name = "LicensingDisabledError";
}

/**
 * The single licensing on/off gate, shared by the machine and publisher
 * surfaces. Call it after authentication and authorisation, so a caller who
 * fails those learns nothing about the deployment's configuration, and before
 * anything is read or written. The flag keeps its historical name
 * LICENSING_KEEPER_ENABLED although it gates the whole write path.
 */
export function makeRequireEnabled(cfg: { enabled: boolean }): () => void {
  return () => {
    if (!cfg.enabled) {
      throw new LicensingDisabledError(
        "licensing is disabled on this deployment (set LICENSING_KEEPER_ENABLED=true to enable provisioning, applying and releasing)",
      );
    }
  };
}

const toGql = (r: AppUserEnvironments) => ({
  appId: r.app_id,
  user: r.user_address,
  environmentId: r.environment_id,
  licenseId: r.license_id,
  templateHash: r.template_hash,
});

/**
 * No field here takes an app id from its arguments. Every resolver derives it
 * from the caller's App identity via resolveCallerApp.
 */
export function createResolvers(
  db: Kysely<VetraLicensingDB>,
  deps: ResolverDeps,
): Record<string, unknown> {
  const { findRow, countForApp, maxForApp, claimRow, upsertRow } =
    createEnvironmentRows(db, deps.cfg);

  // Gate for every mutation; see makeRequireEnabled for ordering rules.
  const requireEnabled = makeRequireEnabled(deps.cfg);

  return {
    Query: { vetraLicensing: () => ({}) },
    Mutation: { vetraLicensing: () => ({}) },

    VetraLicensingQueries: {
      appLicenses: async (
        _p: unknown,
        args: { status?: string | null },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return deps.read.licenses(appId, args.status ?? null);
      },
      appLicenseTypes: async (_p: unknown, _a: unknown, ctx: AuthContext) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return deps.read.licenseTypes(appId);
      },
      appUserEnvironments: async (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const rows = await db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", appId)
          .execute();
        return rows.map(toGql);
      },
    },

    VetraLicensingMutations: {
      issuePublisherGrant: async (
        _p: unknown,
        args: { input: { licenseTypeId: string; user: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        return issuePublisherGrant(deps.grant, {
          appId,
          licenseTypeId: args.input.licenseTypeId,
          user: args.input.user,
          // resolveCallerApp guarantees an authenticated context.
          issuedBy: ctx.user?.address ?? "",
          // Supplied here, never in a reducer: a UTC `Z` instant from
          // toISOString() keeps every stored timestamp lexically comparable.
          now: new Date().toISOString(),
        });
      },

      applyEnvironmentTemplate: async (
        _p: unknown,
        args: { input: { licenseId: string; label: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        // Looked up inside the caller's own active licences, so a licence id
        // belonging to another app is indistinguishable from an unknown one.
        const licenses = await deps.read.licenses(appId, "ACTIVE");
        const licence = licenses.find((l) => l.id === args.input.licenseId);
        if (!licence) {
          throw new Error(
            `license ${args.input.licenseId} is not an active license of app ${appId}`,
          );
        }
        const row = await applyEnvironmentTemplate(
          {
            ...deps.provision,
            findRow,
            countForApp,
            maxForApp,
            claimRow,
            upsertRow,
          },
          {
            appId,
            user: licence.user,
            licenseId: licence.id,
            template: await deps.read.templateFor(licence.id),
            label: args.input.label,
            now: new Date().toISOString(),
          },
        );
        return toGql(row);
      },

      releaseEnvironment: async (
        _p: unknown,
        args: { input: { environmentId: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        return releaseEnvironment(deps.release, appId, args.input.environmentId);
      },
    },
  };
}
