import type { Kysely } from "kysely";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";
import { UnauthenticatedError, type AuthContext } from "./auth.js";
import type { Action } from "document-model";
import {
  resolveOwnerApp,
  NotAppOwnerError,
  UnknownAppError,
  type PublisherAuthDeps,
} from "./publisher-auth.js";
import type { LicenseReads } from "./reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseTypeGateway } from "./license-type-gateway.js";
import type { LicenseGateway } from "./license-gateway.js";
import type { GrantDeps } from "./issuers/publisher-grant.js";
import { makeRequireEnabled } from "./resolvers.js";
import { actions } from "document-models/app-license-type";
import { NegativeValidityError } from "../../document-models/app-license-type/v1/gen/license-type/error.js";
import { actions as licenseActions } from "document-models/app-owner-license";
import { issuePublisherGrant } from "./issuers/publisher-grant.js";
import {
  toPublisherGraphQLError,
  UnknownLicenseError,
  UnknownLicenseTypeError,
} from "./publisher-errors.js";

// Defined in publisher-errors.ts (which maps them to GraphQL codes) so that
// module does not import this one; re-exported to keep existing import paths.
export {
  UnknownLicenseTypeError,
  UnknownLicenseError,
} from "./publisher-errors.js";

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

type TemplateServiceType = Parameters<
  typeof actions.addTemplateService
>[0]["type"];

type AutoUpdateChannel = NonNullable<
  Parameters<typeof actions.addTemplateService>[0]["artifactChannel"]
>;

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
  const requireEnabled = makeRequireEnabled(deps.cfg);

  /**
   * Gate for every field keyed on a licence type id. The app is read from the
   * document itself, never from arguments: another publisher's type fails
   * exactly like a missing one.
   */
  const authoriseType = async (licenseTypeId: string, ctx: Ctx) => {
    if (!ctx.user?.address) {
      throw new UnauthenticatedError("sign in to manage licences");
    }
    const type = await deps.reads.licenseType(licenseTypeId);
    if (!type) throw new UnknownLicenseTypeError();
    try {
      await resolveOwnerApp(deps.auth, ctx, type.app);
    } catch (err) {
      if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) {
        throw new UnknownLicenseTypeError();
      }
      throw err;
    }
    requireEnabled();
    return { id: licenseTypeId, type };
  };

  /**
   * Gate for revokeLicense. The app is read from the licence document itself,
   * never from arguments: another publisher's licence fails exactly like a
   * missing one.
   */
  const authoriseLicense = async (licenseId: string, ctx: Ctx) => {
    if (!ctx.user?.address) {
      throw new UnauthenticatedError("sign in to manage licences");
    }
    const license = await deps.reads.license(licenseId);
    if (!license) throw new UnknownLicenseError();
    try {
      await resolveOwnerApp(deps.auth, ctx, license.app);
    } catch (err) {
      if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) {
        throw new UnknownLicenseError();
      }
      throw err;
    }
    requireEnabled();
    return licenseId;
  };

  const dispatch = async (id: string, acts: Action[]) => {
    await deps.typeGateway.execute(id, acts);
    return true;
  };

  // Converts a thrown licensing error into a GraphQLError with a stable
  // extensions.code. Wraps the whole field, so gate order is untouched.
  const withCodes =
    <A, R>(fn: (p: unknown, a: A, c: Ctx) => Promise<R>) =>
    async (p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(p, a, c);
      } catch (err) {
        throw toPublisherGraphQLError(err);
      }
    };

  return {
    Query: { vetraPublisher: () => ({}) },
    Mutation: { vetraPublisher: () => ({}) },

    VetraPublisherQueries: {
      myApps: withCodes(async (_p: unknown, _a: unknown, ctx: Ctx) => {
        const address = ctx.user?.address;
        if (!address) {
          throw new UnauthenticatedError("sign in to manage licences");
        }
        const apps = await deps.auth.listAppsForOwner(address.toLowerCase());
        return apps.map((a) => ({ id: a.id, name: a.name, status: a.status }));
      }),

      licenseTypes: withCodes(
        async (_p: unknown, args: { appId: string }, ctx: Ctx) => {
          const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
          const types = await deps.reads.licenseTypeDetails(appId);
          return types.map((t) => ({
            id: t.id,
            kind: t.kind,
            label: t.label,
            status: t.status,
            validityDays: t.validityDays,
            templateHash: t.templateHash,
            size: t.template.size,
            baseDomain: t.template.baseDomain,
            packageRegistry: t.template.packageRegistry,
            services: t.template.services,
            packages: t.template.packages,
          }));
        },
      ),

      appArtifacts: withCodes(
        async (_p: unknown, args: { appId: string }, ctx: Ctx) => {
          const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
          return deps.reads.appArtifacts(appId);
        },
      ),

      licenses: withCodes(
        async (
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
      ),

      environments: withCodes(
        async (_p: unknown, args: { appId: string }, ctx: Ctx) => {
          const { appId } = await resolveOwnerApp(deps.auth, ctx, args.appId);
          const rows = await db
            .selectFrom("app_user_environments")
            .selectAll()
            .where("app_id", "=", appId)
            .execute();
          return rows.map(toGql);
        },
      ),
    },

    VetraPublisherMutations: {
      createLicenseType: withCodes(
        async (
          _p: unknown,
          args: {
            input: {
              appId: string;
              kind: string;
              label?: string | null;
              validityDays?: number | null;
            };
          },
          ctx: Ctx,
        ) => {
          const { appId } = await resolveOwnerApp(
            deps.auth,
            ctx,
            args.input.appId,
          );
          requireEnabled();
          // Refuse BEFORE anything is created, as publisher-grant does for the
          // holder address: a rejected execute after create() would leave an
          // orphan document (app: null) that no read can ever see. Building the
          // action runs the action creator's own input check; the validity rule
          // below is the reducer's, pinned to it by a test that runs the reducer.
          const validityDays = args.input.validityDays ?? null;
          const detailsAction = actions.setLicenseTypeDetails({
            app: appId,
            kind: args.input.kind,
            label: args.input.label ?? null,
            validityDays,
          });
          if (validityDays !== null && validityDays <= 0) {
            throw new NegativeValidityError("validityDays must be positive");
          }
          const id = await deps.typeGateway.create();
          await deps.typeGateway.execute(id, [detailsAction]);
          return id;
        },
      ),

      setLicenseTypeDetails: withCodes(
        async (
          _p: unknown,
          args: {
            input: {
              licenseTypeId: string;
              kind?: string | null;
              label?: string | null;
              validityDays?: number | null;
            };
          },
          ctx: Ctx,
        ) => {
          const { id, type } = await authoriseType(
            args.input.licenseTypeId,
            ctx,
          );
          // The reducer always assigns validityDays, so an omitted key must
          // carry the current value, or an unrelated edit would wipe it. Test key
          // presence, not truthiness: explicit null clears, and 0 is a value.
          const validityDays =
            "validityDays" in args.input
              ? (args.input.validityDays ?? null)
              : (type.validityDays ?? null);
          // No `app` key, ever: the reducer would reassign the type to that app,
          // a cross-tenant write. Omitted, the reducer leaves the app untouched.
          return dispatch(id, [
            actions.setLicenseTypeDetails({
              kind: args.input.kind ?? null,
              label: args.input.label ?? null,
              validityDays,
            }),
          ]);
        },
      ),

      setLicenseTypeTemplate: withCodes(
        async (
          _p: unknown,
          args: {
            input: {
              licenseTypeId: string;
              size?: string | null;
              baseDomain?: string | null;
              packageRegistry?: string | null;
            };
          },
          ctx: Ctx,
        ) => {
          const { id } = await authoriseType(args.input.licenseTypeId, ctx);
          return dispatch(id, [
            actions.setTemplate({
              size: args.input.size ?? null,
              baseDomain: args.input.baseDomain ?? null,
              packageRegistry: args.input.packageRegistry ?? null,
            }),
          ]);
        },
      ),

      addLicenseTypeService: withCodes(
        async (
          _p: unknown,
          args: {
            input: {
              licenseTypeId: string;
              type: string;
              prefix?: string | null;
              artifactName?: string | null;
              artifactChannel?: string | null;
            };
          },
          ctx: Ctx,
        ) => {
          const { id } = await authoriseType(args.input.licenseTypeId, ctx);
          return dispatch(id, [
            actions.addTemplateService({
              id: crypto.randomUUID(),
              type: args.input.type as TemplateServiceType,
              prefix: args.input.prefix ?? null,
              artifactName: args.input.artifactName ?? null,
              artifactChannel:
                (args.input.artifactChannel as AutoUpdateChannel | null) ??
                null,
            }),
          ]);
        },
      ),

      removeLicenseTypeService: withCodes(
        async (
          _p: unknown,
          args: { input: { licenseTypeId: string; id: string } },
          ctx: Ctx,
        ) => {
          const { id } = await authoriseType(args.input.licenseTypeId, ctx);
          return dispatch(id, [
            actions.removeTemplateService({ id: args.input.id }),
          ]);
        },
      ),

      removeLicenseTypePackage: withCodes(
        async (
          _p: unknown,
          args: { input: { licenseTypeId: string; id: string } },
          ctx: Ctx,
        ) => {
          const { id } = await authoriseType(args.input.licenseTypeId, ctx);
          return dispatch(id, [
            actions.removeTemplatePackage({ id: args.input.id }),
          ]);
        },
      ),

      addLicenseTypePackage: withCodes(
        async (
          _p: unknown,
          args: {
            input: {
              licenseTypeId: string;
              packageName: string;
              version?: string | null;
            };
          },
          ctx: Ctx,
        ) => {
          const { id } = await authoriseType(args.input.licenseTypeId, ctx);
          return dispatch(id, [
            actions.addTemplatePackage({
              id: crypto.randomUUID(),
              packageName: args.input.packageName,
              version: args.input.version ?? null,
            }),
          ]);
        },
      ),

      publishLicenseType: withCodes(
        async (_p: unknown, args: { licenseTypeId: string }, ctx: Ctx) => {
          const { id } = await authoriseType(args.licenseTypeId, ctx);
          return dispatch(id, [actions.publishLicenseType({})]);
        },
      ),

      retireLicenseType: withCodes(
        async (_p: unknown, args: { licenseTypeId: string }, ctx: Ctx) => {
          const { id } = await authoriseType(args.licenseTypeId, ctx);
          return dispatch(id, [actions.retireLicenseType({})]);
        },
      ),

      issueGrant: withCodes(
        async (
          _p: unknown,
          args: {
            input: { appId: string; licenseTypeId: string; user: string };
          },
          ctx: Ctx,
        ) => {
          const { appId } = await resolveOwnerApp(
            deps.auth,
            ctx,
            args.input.appId,
          );
          requireEnabled();
          return issuePublisherGrant(deps.grant, {
            appId,
            licenseTypeId: args.input.licenseTypeId,
            user: args.input.user,
            // resolveOwnerApp has already refused an unauthenticated caller.
            issuedBy: ctx.user!.address,
            now: new Date().toISOString(),
          });
        },
      ),

      revokeLicense: withCodes(
        async (
          _p: unknown,
          args: { input: { licenseId: string; reason?: string | null } },
          ctx: Ctx,
        ) => {
          const id = await authoriseLicense(args.input.licenseId, ctx);
          await deps.licenseGateway.execute(id, [
            licenseActions.revokeLicense({ reason: args.input.reason ?? null }),
          ]);
          return true;
        },
      ),
    },
  };
}
