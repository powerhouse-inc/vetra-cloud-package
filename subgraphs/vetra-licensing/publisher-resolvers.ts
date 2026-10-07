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
import { actions as licenseActions } from "document-models/app-owner-license";
import { issuePublisherGrant } from "./issuers/publisher-grant.js";

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

type TemplateServiceType = Parameters<
  typeof actions.addTemplateService
>[0]["type"];

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
    return licenseTypeId;
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

    VetraPublisherMutations: {
      createLicenseType: async (
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
        const id = await deps.typeGateway.create();
        await deps.typeGateway.execute(id, [
          actions.setLicenseTypeDetails({
            app: appId,
            kind: args.input.kind,
            label: args.input.label ?? null,
            validityDays: args.input.validityDays ?? null,
          }),
        ]);
        return id;
      },

      setLicenseTypeTemplate: async (
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
        const id = await authoriseType(args.input.licenseTypeId, ctx);
        return dispatch(id, [
          actions.setTemplate({
            size: args.input.size ?? null,
            baseDomain: args.input.baseDomain ?? null,
            packageRegistry: args.input.packageRegistry ?? null,
          }),
        ]);
      },

      addLicenseTypeService: async (
        _p: unknown,
        args: {
          input: { licenseTypeId: string; type: string; prefix?: string | null };
        },
        ctx: Ctx,
      ) => {
        const id = await authoriseType(args.input.licenseTypeId, ctx);
        return dispatch(id, [
          actions.addTemplateService({
            id: crypto.randomUUID(),
            type: args.input.type as TemplateServiceType,
            prefix: args.input.prefix ?? null,
          }),
        ]);
      },

      addLicenseTypePackage: async (
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
        const id = await authoriseType(args.input.licenseTypeId, ctx);
        return dispatch(id, [
          actions.addTemplatePackage({
            id: crypto.randomUUID(),
            packageName: args.input.packageName,
            version: args.input.version ?? null,
          }),
        ]);
      },

      publishLicenseType: async (
        _p: unknown,
        args: { licenseTypeId: string },
        ctx: Ctx,
      ) => {
        const id = await authoriseType(args.licenseTypeId, ctx);
        return dispatch(id, [actions.publishLicenseType({})]);
      },

      retireLicenseType: async (
        _p: unknown,
        args: { licenseTypeId: string },
        ctx: Ctx,
      ) => {
        const id = await authoriseType(args.licenseTypeId, ctx);
        return dispatch(id, [actions.retireLicenseType({})]);
      },

      issueGrant: async (
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

      revokeLicense: async (
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
    },
  };
}
