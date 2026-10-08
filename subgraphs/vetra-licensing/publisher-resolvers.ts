import type { Kysely } from "kysely";
import type { Action } from "document-model";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import { UnauthenticatedError, type AuthContext } from "./auth.js";
import {
  resolveOwnerApp,
  NotAppOwnerError,
  UnknownAppError,
  type PublisherAuthDeps,
} from "./publisher-auth.js";
import type { AppDocView, AppReads } from "./app-reads.js";
import type { AppLicensingWriter } from "./licensing-ledger.js";
import type { LicenseGateway } from "./license-gateway.js";
import type { LicenseReads } from "./reads.js";
import type { LifecycleStore } from "./lifecycle.js";
import type { GrantRow, GrantStore } from "./grants.js";
import type { ChainEnvRows } from "./environments.js";
import type { VetraLicensingDB } from "./db/schema.js";
import { KeyStorageUnavailableError, type KeyVault } from "./key-vault.js";
import type { LicensingConfig } from "./config.js";
import { makeRequireEnabled } from "./resolvers.js";
import { normaliseUserDid } from "./did.js";
import { grantLicense, replaceGrant, type PublisherGrantDeps } from "./issuers/publisher-grant.js";
import { TermNotIssuableError } from "./issue.js";
import { createInviteCode, listInviteCodes, setInviteCodeActive } from "./invite-codes.js";
import {
  AppTamperedError,
  InvalidPublisherInputError,
  UnknownInviteCodeError,
  UnknownLicenseError,
  UnknownTemplateError,
  UnknownTermError,
  toLicensingGraphQLError,
} from "./publisher-errors.js";

export interface PublisherDeps {
  auth: PublisherAuthDeps;
  /** Ledger-checked app reads: `tampered` is filled in. */
  apps: Pick<AppReads, "app">;
  /** The ONLY route for template and term writes: keeps the app-state ledger valid. */
  appWriter: AppLicensingWriter;
  licences: Pick<LicenseReads, "licenceRecords">;
  /** The recorded lifecycle status, which wins over the licence document's. */
  lifecycle: Pick<LifecycleStore, "all">;
  /** The recording gateway: every lifecycle write also lands in license_lifecycle. */
  licenseGateway: Pick<LicenseGateway, "execute">;
  issue: PublisherGrantDeps;
  grants: Pick<
    GrantStore,
    "grantFor" | "grantsForApp" | "allowList" | "addToAllowList" | "removeFromAllowList"
  >;
  envRows: Pick<ChainEnvRows, "forApp">;
  codes: Kysely<VetraLicensingDB>;
  /** Null when OPENBAO_ADDR is unset: attached Claude keys are then refused. */
  keyVault: KeyVault | null;
  cfg: Pick<LicensingConfig, "enabled">;
  newId(): string;
  now(): string;
}

type Ctx = AuthContext & { isAdmin?: (a: string) => boolean };
type In<T> = { input: T };
type Opt<T> = T | null | undefined;

const MODES = ["SHARED", "DEDICATED"] as const;
const ISSUERS = ["INVITE_CODE", "PUBLISHER_GRANT", "ACHRA_SUBSCRIPTION"] as const;
const SERVICE_TYPES = [
  "CONNECT", "SWITCHBOARD", "FUSION", "CLINT", "DOCLING", "PAPERLESS", "SPECKLE",
] as const;
const CHANNELS = ["DEV", "STAGING", "LATEST"] as const;

/** Enum-valued fields travel as String; anything off the list is INVALID_INPUT. */
function oneOf<T extends string>(list: readonly T[], v: string, field: string): T {
  const found = list.find((x) => x === v);
  if (!found) throw new InvalidPublisherInputError(`${field} must be one of ${list.join(", ")}`);
  return found;
}

function maybeOneOf<T extends string>(list: readonly T[], v: Opt<string>, field: string): T | null {
  return v === null || v === undefined ? null : oneOf(list, v, field);
}

/** Only the keys the caller actually sent: absent = unchanged, null = clear. */
function present<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (k in input) out[k] = input[k];
  return out;
}

/**
 * Builds an action. The action creators validate their input (scalars such as
 * URL), so a malformed value refuses here, as INVALID_INPUT, before anything
 * is written.
 */
function action(make: () => Action): Action {
  try {
    return make();
  } catch (err) {
    throw new InvalidPublisherInputError(
      `invalid input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function callerAddress(ctx: Ctx): string {
  const address = ctx.user?.address;
  if (!address) throw new UnauthenticatedError("sign in to manage licences");
  return address;
}

/**
 * The human surface (contract § vetraPublisher). Every field authorises the
 * app against its owner (the `apps` row, never the document) on every call;
 * a licence id is authorised against the app of its GRANT ROW, never against
 * an argument or the licence document. Reads are deliberately not gated on
 * cfg.enabled, so an operator can inspect a deployment that is switched off;
 * writes check the switch only after authorisation, so a stranger learns
 * nothing about the deployment.
 */
export function createPublisherResolvers(deps: PublisherDeps): Record<string, unknown> {
  const requireEnabled = makeRequireEnabled(deps.cfg);

  // Converts a thrown licensing error into a GraphQLError with the contract's
  // extensions.code. Wraps the whole field, so gate order is untouched.
  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };

  /** Ownership, then (writes only) the deployment switch. */
  const owned = async (appId: string, ctx: Ctx, write: boolean): Promise<string> => {
    const { appId: id } = await resolveOwnerApp(deps.auth, ctx, appId);
    if (write) requireEnabled();
    return id;
  };

  /** The app's document for reading; null before the document exists. */
  const readable = async (appId: string, ctx: Ctx): Promise<AppDocView | null> => {
    const id = await owned(appId, ctx, false);
    return deps.apps.app(id);
  };

  /**
   * The app's document for a write built on its templates or terms. A
   * tampered app is refused: its state is not the system's, and writing on
   * top of it would only bury the change. An unverified app (no ledger row
   * yet) is writable; the writer seeds its row.
   */
  const writable = async (appId: string, ctx: Ctx): Promise<AppDocView> => {
    const id = await owned(appId, ctx, true);
    const app = await deps.apps.app(id);
    if (!app) throw new UnknownAppError("no such app");
    if (app.tampered) throw new AppTamperedError(app.id);
    return app;
  };

  const withTemplate = async (appId: string, templateId: string, ctx: Ctx) => {
    const app = await writable(appId, ctx);
    if (!app.templates.some((t) => t.id === templateId)) throw new UnknownTemplateError();
    return app;
  };

  const withTerm = async (appId: string, termId: string, ctx: Ctx) => {
    const app = await writable(appId, ctx);
    if (!app.terms.some((t) => t.id === termId)) throw new UnknownTermError();
    return app;
  };

  const write = async (app: AppDocView, acts: Action[]): Promise<true> => {
    await deps.appWriter.appendLicensingOps(app.id, acts);
    return true;
  };

  /**
   * A licence id, authorised against the app its grant row names. Another
   * publisher's licence, a licence without a grant row and a missing one all
   * fail alike.
   */
  const ownedLicence = async (licenseId: string, ctx: Ctx): Promise<GrantRow> => {
    callerAddress(ctx);
    const grant = await deps.grants.grantFor(licenseId);
    if (!grant) throw new UnknownLicenseError();
    try {
      await resolveOwnerApp(deps.auth, ctx, grant.appId);
    } catch (err) {
      if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) {
        throw new UnknownLicenseError();
      }
      throw err;
    }
    requireEnabled();
    return grant;
  };

  /**
   * The app's licences: those with a grant row for it (a licence document
   * naming the app proves nothing), with the lifecycle status the system
   * recorded over the document's.
   */
  const licencesOf = async (appId: string) => {
    const grants = await deps.grants.grantsForApp(appId);
    const [docs, lifecycle] = await Promise.all([
      deps.licences.licenceRecords(grants.map((g) => g.licenseId)),
      deps.lifecycle.all(),
    ]);
    const byId = new Map(docs.map((d) => [d.id, d]));
    return grants.flatMap((g) => {
      const doc = byId.get(g.licenseId);
      if (!doc) return [];
      const rec = lifecycle.get(g.licenseId);
      const status = rec?.status ?? doc.status;
      return [{
        id: g.licenseId,
        user: g.userDid,
        kind: g.kind ?? doc.kind ?? "",
        issuer: doc.issuer ?? "PUBLISHER_GRANT",
        status,
        start: doc.start,
        end: doc.end,
        environmentId: doc.stage,
        replacedBy: status === "REPLACED" ? (rec?.replacedBy ?? doc.replacedBy) : null,
      }];
    });
  };

  return {
    Query: { vetraPublisher: () => ({}) },
    Mutation: { vetraPublisher: () => ({}) },

    VetraPublisherQueries: {
      myApps: withCodes(async (_a: unknown, ctx) => {
        const apps = await deps.auth.listAppsForOwner(callerAddress(ctx).toLowerCase());
        return apps.map((a) => ({ id: a.id, name: a.name, status: a.status }));
      }),

      templates: withCodes(async (a: { appId: string }, ctx) => {
        const app = await readable(a.appId, ctx);
        if (!app) return [];
        const envs = await deps.envRows.forApp(app.id);
        return app.templates.map((t) => ({
          id: t.id,
          name: t.name,
          mode: t.mode,
          sharedEnvironment: t.sharedEnvironment,
          size: t.template.size,
          baseDomain: t.template.baseDomain,
          packageRegistry: t.template.packageRegistry,
          services: t.template.services.map((s) => ({
            id: s.id,
            type: s.type,
            prefix: s.prefix,
            artifactName: s.artifactName ?? null,
            artifactChannel: s.artifactChannel ?? null,
          })),
          packages: t.template.packages,
          templateHash: t.templateHash,
          environmentCount: envs.filter((e) => e.template_id === t.id).length,
        }));
      }),

      terms: withCodes(async (a: { appId: string }, ctx) => {
        const app = await readable(a.appId, ctx);
        if (!app) return [];
        const active = (await licencesOf(app.id)).filter((l) => l.status === "ACTIVE");
        return app.terms.map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          templateId: t.templateId,
          validityDays: t.validityDays,
          issuers: t.issuers,
          status: t.status,
          activeLicenses: active.filter((l) => l.kind === t.kind).length,
        }));
      }),

      appArtifacts: withCodes(
        async (a: { appId: string }, ctx) => (await readable(a.appId, ctx))?.artifacts ?? [],
      ),

      licenses: withCodes(async (a: { appId: string; status?: Opt<string> }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return (await licencesOf(appId)).filter((l) => !a.status || l.status === a.status);
      }),

      // license_environments (one row per licence chain), never the legacy
      // app_user_environments.
      environments: withCodes(async (a: { appId: string }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return (await deps.envRows.forApp(appId)).map((e) => ({
          environmentId: e.environment_id,
          user: e.user_did,
          licenseId: e.license_id,
          rootLicenseId: e.root_license_id,
          label: e.label,
          templateHash: e.template_hash,
          stoppedAt: e.stopped_at,
          deleteAfter: e.delete_after,
        }));
      }),

      inviteCodes: withCodes(async (a: { appId: string }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return listInviteCodes(deps.codes, appId);
      }),

      allowList: withCodes(async (a: { appId: string }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return deps.grants.allowList(appId);
      }),
    },

    VetraPublisherMutations: {
      addTemplate: withCodes(async (a: In<{ appId: string; name?: Opt<string>; mode: string }>, ctx) => {
        const app = await writable(a.input.appId, ctx);
        const id = deps.newId();
        const mode = oneOf(MODES, a.input.mode, "mode");
        await write(app, [action(() => appActions.addTemplate({ id, name: a.input.name ?? null, mode }))]);
        return id;
      }),

      setTemplateDetails: withCodes(
        async (
          a: In<{
            appId: string;
            templateId: string;
            name?: Opt<string>;
            mode?: Opt<string>;
            sharedEnvironment?: Opt<string>;
            size?: Opt<string>;
            baseDomain?: Opt<string>;
            packageRegistry?: Opt<string>;
          }>,
          ctx,
        ) => {
          const app = await withTemplate(a.input.appId, a.input.templateId, ctx);
          const fields = present(a.input, [
            "name", "sharedEnvironment", "size", "baseDomain", "packageRegistry",
          ] as const);
          // A template always has a mode: null leaves it unchanged.
          const mode = maybeOneOf(MODES, a.input.mode, "mode");
          return write(app, [
            action(() =>
              appActions.setTemplateDetails({ id: a.input.templateId, ...fields, ...(mode ? { mode } : {}) }),
            ),
          ]);
        },
      ),

      addTemplateService: withCodes(
        async (
          a: In<{
            appId: string;
            templateId: string;
            type: string;
            prefix?: Opt<string>;
            artifactName?: Opt<string>;
            artifactChannel?: Opt<string>;
          }>,
          ctx,
        ) => {
          const app = await withTemplate(a.input.appId, a.input.templateId, ctx);
          const type = oneOf(SERVICE_TYPES, a.input.type, "type");
          const artifactChannel = maybeOneOf(CHANNELS, a.input.artifactChannel, "artifactChannel");
          return write(app, [
            action(() =>
              appActions.addTemplateService({
                templateId: a.input.templateId,
                id: deps.newId(),
                type,
                prefix: a.input.prefix ?? null,
                artifactName: a.input.artifactName ?? null,
                artifactChannel,
              }),
            ),
          ]);
        },
      ),

      removeTemplateService: withCodes(
        async (a: In<{ appId: string; templateId: string; id: string }>, ctx) => {
          const app = await withTemplate(a.input.appId, a.input.templateId, ctx);
          return write(app, [
            action(() => appActions.removeTemplateService({ templateId: a.input.templateId, id: a.input.id })),
          ]);
        },
      ),

      addTemplatePackage: withCodes(
        async (
          a: In<{ appId: string; templateId: string; packageName: string; version?: Opt<string> }>,
          ctx,
        ) => {
          const app = await withTemplate(a.input.appId, a.input.templateId, ctx);
          return write(app, [
            action(() =>
              appActions.addTemplatePackage({
                templateId: a.input.templateId,
                id: deps.newId(),
                packageName: a.input.packageName,
                version: a.input.version ?? null,
              }),
            ),
          ]);
        },
      ),

      removeTemplatePackage: withCodes(
        async (a: In<{ appId: string; templateId: string; id: string }>, ctx) => {
          const app = await withTemplate(a.input.appId, a.input.templateId, ctx);
          return write(app, [
            action(() => appActions.removeTemplatePackage({ templateId: a.input.templateId, id: a.input.id })),
          ]);
        },
      ),

      deleteTemplate: withCodes(async (a: { appId: string; templateId: string }, ctx) => {
        const app = await withTemplate(a.appId, a.templateId, ctx);
        return write(app, [action(() => appActions.deleteTemplate({ id: a.templateId }))]);
      }),

      addTerm: withCodes(
        async (
          a: In<{
            appId: string;
            kind: string;
            label?: Opt<string>;
            templateId?: Opt<string>;
            validityDays?: Opt<number>;
            issuers?: Opt<string[]>;
          }>,
          ctx,
        ) => {
          const app = await writable(a.input.appId, ctx);
          const id = deps.newId();
          const issuers = (a.input.issuers ?? []).map((i) => oneOf(ISSUERS, i, "issuers"));
          await write(app, [
            action(() =>
              appActions.addTerm({
                id,
                kind: a.input.kind,
                label: a.input.label ?? null,
                templateId: a.input.templateId ?? null,
                validityDays: a.input.validityDays ?? null,
                issuers,
              }),
            ),
          ]);
          return id;
        },
      ),

      setTermDetails: withCodes(
        async (
          a: In<{
            appId: string;
            termId: string;
            kind?: Opt<string>;
            label?: Opt<string>;
            templateId?: Opt<string>;
            validityDays?: Opt<number>;
            issuers?: Opt<string[]>;
          }>,
          ctx,
        ) => {
          const app = await withTerm(a.input.appId, a.input.termId, ctx);
          const fields = present(a.input, ["kind", "label", "templateId", "validityDays"] as const);
          // A term always has an issuer list: null leaves it unchanged.
          const issuers = a.input.issuers?.map((i) => oneOf(ISSUERS, i, "issuers"));
          return write(app, [
            action(() =>
              appActions.setTermDetails({ id: a.input.termId, ...fields, ...(issuers ? { issuers } : {}) }),
            ),
          ]);
        },
      ),

      publishTerm: withCodes(async (a: { appId: string; termId: string }, ctx) =>
        write(await withTerm(a.appId, a.termId, ctx), [action(() => appActions.publishTerm({ id: a.termId }))]),
      ),

      retireTerm: withCodes(async (a: { appId: string; termId: string }, ctx) =>
        write(await withTerm(a.appId, a.termId, ctx), [action(() => appActions.retireTerm({ id: a.termId }))]),
      ),

      issueGrant: withCodes(
        async (a: In<{ appId: string; kind: string; user: string; label?: Opt<string> }>, ctx) => {
          const appId = await owned(a.input.appId, ctx, true);
          return grantLicense(deps.issue, {
            appId,
            kind: a.input.kind,
            user: a.input.user,
            issuedBy: callerAddress(ctx),
            label: a.input.label ?? null,
            now: deps.now(),
          });
        },
      ),

      replaceGrant: withCodes(async (a: In<{ licenseId: string; kind: string }>, ctx) => {
        const grant = await ownedLicence(a.input.licenseId, ctx);
        return replaceGrant(deps.issue, {
          appId: grant.appId,
          licenseId: grant.licenseId,
          kind: a.input.kind,
          issuedBy: callerAddress(ctx),
          now: deps.now(),
        });
      }),

      revokeLicense: withCodes(async (a: In<{ licenseId: string; reason?: Opt<string> }>, ctx) => {
        const grant = await ownedLicence(a.input.licenseId, ctx);
        await deps.licenseGateway.execute(grant.licenseId, [
          licenseActions.revokeLicense({ reason: a.input.reason ?? null }),
        ]);
        return true;
      }),

      createInviteCode: withCodes(
        async (
          a: In<{
            appId: string;
            kind: string;
            label?: Opt<string>;
            code?: Opt<string>;
            expiresAt?: Opt<string>;
            maxUses?: Opt<number>;
            anthropicKey?: Opt<string>;
          }>,
          ctx,
        ) => {
          const app = await writable(a.input.appId, ctx);
          // A DRAFT term is allowed on purpose: codes can be printed before
          // the term is published; redemption still requires it ACTIVE.
          const term = app.terms.find((t) => t.kind === a.input.kind);
          if (!term || term.status === "RETIRED" || !term.issuers.includes("INVITE_CODE")) {
            throw new TermNotIssuableError(`${a.input.kind} cannot be issued by invite code`);
          }
          let anthropicKeyCiphertext: string | null = null;
          if (a.input.anthropicKey) {
            if (!deps.keyVault) throw new KeyStorageUnavailableError();
            anthropicKeyCiphertext = await deps.keyVault.encrypt(a.input.anthropicKey);
          }
          return createInviteCode(deps.codes, {
            appId: app.id,
            kind: term.kind,
            code: a.input.code ?? null,
            label: a.input.label ?? null,
            expiresAt: a.input.expiresAt ?? null,
            maxUses: a.input.maxUses ?? null,
            anthropicKeyCiphertext,
            now: deps.now(),
          });
        },
      ),

      setInviteCodeActive: withCodes(
        async (a: { appId: string; code: string; active: boolean }, ctx) => {
          const appId = await owned(a.appId, ctx, true);
          // Another app's code fails exactly like a missing one.
          if (!(await setInviteCodeActive(deps.codes, appId, a.code, a.active))) {
            throw new UnknownInviteCodeError();
          }
          return true;
        },
      ),

      addToAllowList: withCodes(async (a: { appId: string; user: string }, ctx) => {
        const appId = await owned(a.appId, ctx, true);
        await deps.grants.addToAllowList(appId, normaliseUserDid(a.user), deps.now());
        return true;
      }),

      removeFromAllowList: withCodes(async (a: { appId: string; user: string }, ctx) => {
        const appId = await owned(a.appId, ctx, true);
        return deps.grants.removeFromAllowList(appId, normaliseUserDid(a.user));
      }),
    },
  };
}
