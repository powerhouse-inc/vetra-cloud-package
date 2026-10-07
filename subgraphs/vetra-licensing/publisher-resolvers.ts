import type { Kysely } from "kysely";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";
import { UnauthenticatedError, type AuthContext } from "./auth.js";
import { resolveOwnerApp, type PublisherAuthDeps } from "./publisher-auth.js";
import type { LicenseReads } from "./reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseTypeGateway } from "./license-type-gateway.js";
import type { LicenseGateway } from "./license-gateway.js";
import type { GrantDeps } from "./issuers/publisher-grant.js";

/**
 * Thrown by Tasks 6 and 7 for a licence type that is missing OR belongs to
 * another publisher. The message is fixed so the two cases are
 * indistinguishable, as with NotAppOwnerError.
 */
export class UnknownLicenseTypeError extends Error {
  override name = "UnknownLicenseTypeError";
  constructor() {
    super("no such licence type");
  }
}
/** As UnknownLicenseTypeError, for a licence. */
export class UnknownLicenseError extends Error {
  override name = "UnknownLicenseError";
  constructor() {
    super("no such licence");
  }
}

export interface PublisherDeps {
  auth: PublisherAuthDeps;
  reads: LicenseReads;
  cfg: LicensingConfig;
  typeGateway: LicenseTypeGateway;
  licenseGateway: LicenseGateway;
  grant: GrantDeps;
}

const toGql = (r: AppUserEnvironments) => ({
  appId: r.app_id,
  user: r.user_address,
  environmentId: r.environment_id,
  licenseId: r.license_id,
  templateHash: r.template_hash,
});

type Ctx = AuthContext & { isAdmin?: (a: string) => boolean };

/**
 * Human surface. Every field authorises the app against its owner on every
 * call. Reads are deliberately NOT gated on cfg.enabled, so an operator can
 * inspect a deployment that is switched off.
 */
export function createPublisherResolvers(
  db: Kysely<VetraLicensingDB>,
  deps: PublisherDeps,
): Record<string, unknown> {
  return {
    Query: { vetraPublisher: () => ({}) },
    Mutation: { vetraPublisher: () => ({}) },

    VetraPublisherQueries: {
      myApps: async (_p: unknown, _a: unknown, ctx: Ctx) => {
        const address = ctx.user?.address;
        if (!address) {
          throw new UnauthenticatedError("sign in to manage licences");
        }
        const apps = await deps.auth.listAppsForOwner(address.toLowerCase());
        return apps.map((a) => ({ id: a.id, name: a.name, status: a.status }));
      },

      licenseTypes: async (_p: unknown, args: { appId: string }, ctx: Ctx) => {
        const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
        const types = await deps.reads.licenseTypeDetails(appId);
        return types.map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          status: t.status,
          validityDays: t.validityDays,
          templateHash: t.templateHash,
          services: t.template.services,
          packages: t.template.packages,
        }));
      },

      licenses: async (
        _p: unknown,
        args: { appId: string; status?: string | null },
        ctx: Ctx,
      ) => {
        const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
        const [licenses, envs] = await Promise.all([
          deps.reads.licenses(appId, args.status ?? null),
          db
            .selectFrom("app_user_environments")
            .selectAll()
            .where("app_id", "=", appId)
            .execute(),
        ]);
        const envByUser = new Map(
          envs.map((e) => [e.user_address.toLowerCase(), e.environment_id]),
        );
        return licenses.map((l) => ({
          ...l,
          environmentId: envByUser.get(l.user.toLowerCase()) ?? null,
        }));
      },

      environments: async (_p: unknown, args: { appId: string }, ctx: Ctx) => {
        const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
        const rows = await db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", appId)
          .execute();
        return rows.map(toGql);
      },
    },
  };
}
