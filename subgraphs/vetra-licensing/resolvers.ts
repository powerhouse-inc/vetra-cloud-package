import { resolveCallerApp, type AuthContext, type AuthDeps } from "./auth.js";
import { resolveKind, type AppReads } from "./app-reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { normaliseUserDid } from "./did.js";
import {
  EnvironmentOwnershipMismatchError,
  lockChain,
  type ChainEnvRows,
  type ProvisionChainInput,
} from "./environments.js";
import type { AcquireOptions } from "./keyed-mutex.js";
import type { GrantStore } from "./grants.js";
import { grantLicense, type PublisherGrantDeps } from "./issuers/publisher-grant.js";
import { authorisedLicences } from "./licence-view.js";
import type { LifecycleStore } from "./lifecycle.js";
import { markEnded, type OffboardingDeps } from "./offboarding.js";
import {
  InvalidPublisherInputError,
  UnknownLicenseError,
  toLicensingGraphQLError,
} from "./publisher-errors.js";
import type { LicenseReads } from "./reads.js";
import { REPORTING_HEADER } from "./reporting.js";

/** The legacy reads' shapes (reads.ts); removed with them. */
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

/** What the machine surface reads and writes. Every lookup is scoped to the caller's app. */
export interface ResolverDeps {
  auth: AuthDeps;
  /** Ledger-checked app reads: `tampered` and `unverified` are filled in. */
  apps: Pick<AppReads, "app">;
  /** Licence documents: display fields only (licence-view.ts). */
  licences: Pick<LicenseReads, "licenceRecords">;
  /** The recorded lifecycle, which decides status and end over the document. */
  lifecycle: Pick<LifecycleStore, "entries">;
  /** Grant rows: which app, holder and kind every licence was authorised for. */
  grants: Pick<
    GrantStore,
    | "grantFor"
    | "grantsForApp"
    | "grantsForHolder"
    | "chainRootOf"
    | "chainRootsFor"
    | "chainHead"
    | "chainMembers"
    | "chainLabel"
  >;
  /** license_environments: one environment per licence chain. */
  envRows: Pick<ChainEnvRows, "forApp" | "byEnvironment">;
  /**
   * The handler's provisioning path, under the chain's lock
   * (provisionChainExclusive), so a machine call and a handler tick on the
   * same chain never both create an environment. `opts.timeoutMs` bounds the
   * wait for the lock (ChainBusyError, BUSY).
   */
  provision(input: ProvisionChainInput, opts: AcquireOptions): Promise<LicenseEnvironments>;
  offboarding: OffboardingDeps;
  issue: PublisherGrantDeps;
  /** True once the startup migration recorded `complete` (the handler's gate). */
  migrationComplete(): Promise<boolean>;
  cfg: LicensingConfig;
  now(): string;
  /** Forwards a user stat to Renown as the app (reporting.ts relayUserStat); false when refused or off. */
  relay: (token: string | null, input: { user: string; metric: string; value: number }) => Promise<boolean>;
}

type Ctx = AuthContext & { headers?: Record<string, string | string[] | undefined> };

/** A chain is ended only when every licence in it is recorded terminal. */
const TERMINAL = new Set(["EXPIRED", "REVOKED", "REPLACED"]);

const toEnv = (e: LicenseEnvironments) => ({
  appId: e.app_id,
  user: e.user_did,
  environmentId: e.environment_id,
  licenseId: e.license_id,
  rootLicenseId: e.root_license_id,
  label: e.label,
  templateHash: e.template_hash,
  stoppedAt: e.stopped_at,
  deleteAfter: e.delete_after,
});

/**
 * The machine surface (contract § vetraLicensing): an app backend calling
 * with its App identity. No field takes an app id from its arguments; every
 * resolver derives it from the caller via resolveCallerApp. Licence documents
 * are forgeable, so nothing here trusts their app, holder, kind or status:
 * licences are listed and looked up from grant rows and the lifecycle record
 * (licence-view.ts), environments from license_environments. Another app's
 * licence fails exactly like a missing one.
 */
export function createResolvers(deps: ResolverDeps): Record<string, unknown> {
  // Gate for every mutation; see makeRequireEnabled for ordering rules.
  const requireEnabled = makeRequireEnabled(deps.cfg);

  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };

  /** One licence of the caller's app, authorised by its grant row; else NOT_FOUND. */
  const ownLicence = async (appId: string, licenseId: string) => {
    const grant = await deps.grants.grantFor(licenseId);
    if (!grant || grant.appId !== appId) throw new UnknownLicenseError();
    const licence = (await authorisedLicences(deps, [grant])).at(0);
    if (!licence) throw new UnknownLicenseError();
    return licence;
  };

  /**
   * True only when every licence linked into the environment's chain
   * (license_chain, with or without a grant, plus the root) is recorded
   * terminal. A member without a lifecycle record is unknown, never ended:
   * release must not decide "ended" more readily than the handler does.
   */
  const chainEnded = async (row: LicenseEnvironments): Promise<boolean> => {
    const members = await deps.grants.chainMembers(row.root_license_id);
    const recorded = await deps.lifecycle.entries(members);
    return members.every((id) => TERMINAL.has(recorded.get(id)?.status ?? ""));
  };

  /** How long a machine call waits for a chain another caller holds. */
  const lockWait: AcquireOptions = { timeoutMs: deps.cfg.stepTimeoutMs };

  return {
    Query: { vetraLicensing: () => ({}) },
    Mutation: { vetraLicensing: () => ({}) },

    VetraLicensingQueries: {
      appLicenses: withCodes(async (a: { status?: string | null }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const licences = await authorisedLicences(deps, await deps.grants.grantsForApp(appId));
        const [roots, envs, app] = await Promise.all([
          deps.grants.chainRootsFor(licences.map((l) => l.id)),
          deps.envRows.forApp(appId),
          deps.apps.app(appId),
        ]);
        // A SHARED kind's environment is the app's shared one, as the
        // (ledger-checked) app resolves it; never a licence document's stage.
        const sharedStage = (kind: string | null): string | null => {
          if (!app) return null;
          const r = resolveKind(app, kind);
          return r.ok && r.template.mode === "SHARED" ? r.stage : null;
        };
        const envByRoot = new Map(envs.map((e) => [e.root_license_id, e.environment_id]));
        return licences
          .filter((l) => !a.status || l.status === a.status)
          .map((l) => ({
            id: l.id,
            user: l.userDid,
            kind: l.kind ?? "",
            status: l.status,
            start: l.start,
            end: l.end,
            // The chain's environment (license_environments); else, for a
            // SHARED kind, the app's shared environment; else none yet.
            environmentId: envByRoot.get(roots.get(l.id) ?? l.id) ?? sharedStage(l.kind),
          }));
      }),

      appTerms: withCodes(async (_a: unknown, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const app = await deps.apps.app(appId);
        if (!app) return [];
        return app.terms.map((t) => {
          const template = app.templates.find((x) => x.id === t.templateId);
          return {
            id: t.id,
            kind: t.kind,
            status: t.status,
            // Only a DEDICATED template gives a holder an environment to apply.
            templateHash: template?.mode === "DEDICATED" ? template.templateHash : null,
          };
        });
      }),

      // license_environments (one row per licence chain), never the legacy
      // app_user_environments.
      appUserEnvironments: withCodes(async (_a: unknown, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return (await deps.envRows.forApp(appId)).map(toEnv);
      }),

      hasLicense: withCodes(async (a: { user: string }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const user = normaliseUserDid(a.user);
        const ids = (await deps.grants.grantsForHolder(user))
          .filter((g) => g.appId === appId)
          .map((g) => g.licenseId);
        // The lifecycle record only: an unrecorded licence's document is not evidence.
        const recorded = await deps.lifecycle.entries(ids);
        return ids.some((id) => recorded.get(id)?.status === "ACTIVE");
      }),
    },

    VetraLicensingMutations: {
      issuePublisherGrant: withCodes(async (a: { input: { kind: string; user: string } }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        return grantLicense(deps.issue, {
          appId,
          kind: a.input.kind,
          user: a.input.user,
          // resolveCallerApp guarantees the app key.
          issuedBy: ctx.user?.appKey ?? "app",
          label: null,
          now: deps.now(),
        });
      }),

      applyEnvironmentTemplate: withCodes(
        async (a: { input: { licenseId: string; label: string } }, ctx) => {
          const { appId } = await resolveCallerApp(deps.auth, ctx);
          requireEnabled();
          // As the handler: before the migration, license_environments is
          // empty while live environments exist, and a provision now would
          // give a live holder a second environment.
          if (!(await deps.migrationComplete())) {
            throw new InvalidPublisherInputError(
              "environments cannot be applied until the licensing migration has completed",
            );
          }
          const licence = await ownLicence(appId, a.input.licenseId);
          // Only what the handler would serve: an ACTIVE head per the lifecycle record.
          const recorded = (await deps.lifecycle.entries([licence.id])).get(licence.id);
          if (!recorded) {
            throw new InvalidPublisherInputError(
              `licence ${licence.id} has no recorded lifecycle; it is held until the system can vouch for it`,
            );
          }
          if (licence.status !== "ACTIVE") {
            throw new InvalidPublisherInputError(`licence ${licence.id} is ${licence.status}, not ACTIVE`);
          }
          const app = await deps.apps.app(appId);
          if (!app) throw new InvalidPublisherInputError(`app ${appId} has no readable document`);
          // A tampered app does not resolve; an unverified one is held, as by the handler.
          const r = resolveKind(app, licence.kind);
          if (!r.ok) throw new InvalidPublisherInputError(r.reason);
          if (app.unverified) {
            throw new InvalidPublisherInputError(
              `app ${appId} licensing state is unverified; it is held until it is recorded`,
            );
          }
          if (r.template.mode !== "DEDICATED") {
            throw new InvalidPublisherInputError("a SHARED licence has no environment of its own");
          }
          const root = await deps.grants.chainRootOf(licence.id);
          // As the handler: only the chain's newest authorised licence is served.
          if ((await deps.grants.chainHead(root)) !== licence.id) {
            throw new InvalidPublisherInputError(
              `licence ${licence.id} is not the newest licence of its chain; upgrade the newest licence`,
            );
          }
          try {
            const row = await deps.provision(
              {
                appId,
                root,
                licenseId: licence.id,
                // The grant row's holder, never the document's.
                userDid: licence.userDid,
                templateId: r.template.id,
                template: r.template.template,
                templateHash: r.template.templateHash,
                // As the handler: the project name chosen at issue wins.
                label: (await deps.grants.chainLabel(root)) ?? a.input.label,
                now: deps.now(),
              },
              lockWait,
            );
            return toEnv(row);
          } catch (err) {
            // Its message names the other holder and app: not the caller's to see.
            if (err instanceof EnvironmentOwnershipMismatchError) {
              throw new InvalidPublisherInputError(
                "this licence's chain environment is inconsistent with its grant; it is held for review",
              );
            }
            throw err;
          }
        },
      ),

      /**
       * Release = start the offboarding clock (markEnded), and only for a
       * chain the lifecycle record says has ended. Nothing here stops or
       * deletes: the handler's confirmed-ended logic carries the clock on.
       * Releasing a live chain would only be undone by the handler (resumed).
       */
      releaseEnvironment: withCodes(async (a: { input: { environmentId: string } }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        const row = await deps.envRows.byEnvironment(a.input.environmentId);
        if (!row || row.app_id !== appId) return false;
        // Under the chain's lock, so no provision, renewal or resume of the
        // chain interleaves between the check and the write.
        return lockChain(
          row.root_license_id,
          async () => {
            if (!(await chainEnded(row))) return false;
            await markEnded(deps.offboarding, row.environment_id);
            return true;
          },
          lockWait,
        );
      }),

      // The caller is an environment presenting its reporting token, not an app.
      reportUserStat: withCodes(
        async (a: { user: string; metric: string; value: number }, ctx) => {
          const raw = ctx.headers?.[REPORTING_HEADER];
          return deps.relay(typeof raw === "string" ? raw : null, {
            user: a.user,
            metric: a.metric,
            value: a.value,
          });
        },
      ),
    },
  };
}
