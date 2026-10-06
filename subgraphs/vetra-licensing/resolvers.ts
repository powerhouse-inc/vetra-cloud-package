import type { Kysely } from "kysely";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";
import { resolveCallerApp, type AuthContext, type AuthDeps } from "./auth.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "./provision.js";
import { releaseEnvironment, type ReleaseDeps } from "./release.js";
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
    "findRow" | "countForApp" | "maxForApp" | "upsertRow"
  >;
  release: ReleaseDeps;
  cfg: LicensingConfig;
  /** Reads licence and licence-type documents. Every read is scoped to one app. */
  read: {
    licenses(appId: string, status: string | null): Promise<LicenseView[]>;
    licenseTypes(appId: string): Promise<LicenseTypeView[]>;
    /** null when the licence type is missing or RETIRED. */
    templateFor(licenseId: string): Promise<TemplateShape | null>;
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
  // user_address is stored lowercased; normalise at every database boundary so
  // a mixed-case caller can never produce a second row.
  const findRow = (appId: string, user: string) =>
    db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", appId)
      .where("user_address", "=", user.toLowerCase())
      .executeTakeFirst()
      .then((r) => r ?? null);

  const countForApp = (appId: string) =>
    db
      .selectFrom("app_user_environments")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("app_id", "=", appId)
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.n));

  const maxForApp = (appId: string) =>
    db
      .selectFrom("app_environment_limits")
      .select("max_environments")
      .where("app_id", "=", appId)
      .executeTakeFirst()
      .then((r) => r?.max_environments ?? deps.cfg.defaultMaxEnvironments);

  // The conflict clause deliberately leaves environment_id alone, so the loser
  // of a race adopts the winner's environment; the re-read returns that row.
  const upsertRow = async (input: AppUserEnvironments) => {
    const row = { ...input, user_address: input.user_address.toLowerCase() };
    await db
      .insertInto("app_user_environments")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["app_id", "user_address"]).doUpdateSet({
          license_id: row.license_id,
          template_hash: row.template_hash,
          updated_at: row.updated_at,
        }),
      )
      .execute();
    return db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", row.app_id)
      .where("user_address", "=", row.user_address)
      .executeTakeFirstOrThrow();
  };

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
      applyEnvironmentTemplate: async (
        _p: unknown,
        args: { input: { licenseId: string; label: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
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
          { ...deps.provision, findRow, countForApp, maxForApp, upsertRow },
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
        return releaseEnvironment(deps.release, appId, args.input.environmentId);
      },
    },
  };
}
