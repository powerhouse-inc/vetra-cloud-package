import { randomBytes } from "node:crypto";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import { actions as licenseActions } from "document-models/app-owner-license";
import { envUrls } from "../vetra-apps/envs.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import { UnauthenticatedError } from "./auth.js";
import { resolveKind, type AppReads } from "./app-reads.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { addressOfDid, callerDid } from "./did.js";
import type { ChainEnvRows } from "./environments.js";
import type { GrantStore } from "./grants.js";
import { getCode, isUsable } from "./invite-codes.js";
import { withLicenceLock } from "./issue.js";
import { redeemInviteCode, type InviteCodeIssuerDeps } from "./issuers/invite-code.js";
import type { LicenseGateway } from "./license-gateway.js";
import { authorisedLicences, isLive, type AuthorisedLicence } from "./licence-view.js";
import type { LifecycleStore } from "./lifecycle.js";
import { DESTROY_AFTER_DAYS, addDays, subscriptionWarnings, type SubscriptionWarning } from "./offboarding.js";
import {
  ForbiddenError,
  OperationRejectedError,
  UnknownLicenseError,
  toLicensingGraphQLError,
} from "./publisher-errors.js";
import type { LicenseReads } from "./reads.js";
import { studioAccess, studioKeyForDid, type StudioAccessDeps } from "./studio-access.js";

export interface SubscriptionDeps {
  /** The invite-code issuer (Task 7), which issues through issue.ts. */
  issuer: InviteCodeIssuerDeps;
  /** Ledger-checked app reads: a tampered app resolves no kind. */
  apps: Pick<AppReads, "app">;
  licences: Pick<LicenseReads, "licenceRecords">;
  lifecycle: Pick<LifecycleStore, "entries">;
  grants: Pick<GrantStore, "grantsForHolder" | "grantFor" | "chainRootsFor" | "chainLabel">;
  envRows: Pick<ChainEnvRows, "byRoot">;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  /** The recording gateway: a cancel also lands in license_lifecycle. */
  licenseGateway: Pick<LicenseGateway, "execute">;
  studio: StudioAccessDeps;
  /** Null when OPENBAO_ADDR is unset: no key can be written. */
  secrets: Pick<SecretsService, "setSecret"> | null;
  /**
   * The owners (lowercased addresses, null when unset) of the environments
   * deployed as this tenant, from the environment processor's projection.
   * Empty when no environment is known by the tenant id (yet).
   */
  tenantOwners(tenantId: string): Promise<(string | null)[]>;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

export interface Subscription {
  licenseId: string;
  appId: string;
  appName: string;
  kind: string;
  termLabel: string | null;
  issuer: string;
  status: string;
  start: string | null;
  end: string | null;
  mode: "SHARED" | "DEDICATED";
  environmentId: string | null;
  environmentLabel: string | null;
  openUrl: string | null;
  stoppedAt: string | null;
  deleteAfter: string | null;
  warnings: SubscriptionWarning[];
}

type Ctx = { user?: { address?: string } };

const INVALID_CHECK = { valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null };

async function primaryUrl(deps: SubscriptionDeps, environmentId: string): Promise<string | null> {
  const u = envUrls(await deps.envState(environmentId));
  return u.app ?? u.connect ?? u.switchboard;
}

/**
 * One subscription row. `l` is grant-sourced with the recorded lifecycle
 * (licence-view.ts). The environment is the chain's license_environments row,
 * and only when it belongs to the same holder and app; Open goes to its
 * primary URL (DEDICATED) or to the app's environment (SHARED).
 */
export async function subscriptionFor(
  deps: SubscriptionDeps,
  l: AuthorisedLicence,
  root: string,
): Promise<Subscription> {
  const app = await deps.apps.app(l.appId);
  const resolved = app ? resolveKind(app, l.kind) : null;
  const row = await deps.envRows.byRoot(root);
  const envRow: LicenseEnvironments | null =
    row && row.user_did === l.userDid && row.app_id === l.appId ? row : null;
  // A chain with an environment is DEDICATED whatever its template says now
  // (a template switched to SHARED leaves it held, not shared).
  const mode = envRow ? "DEDICATED" : resolved?.ok ? resolved.template.mode : "SHARED";
  const dedicated = mode === "DEDICATED";
  let openUrl: string | null = null;
  if (envRow) openUrl = await primaryUrl(deps, envRow.environment_id);
  else if (!dedicated && resolved?.ok && resolved.stage) openUrl = await primaryUrl(deps, resolved.stage);
  return {
    licenseId: l.id,
    appId: l.appId,
    appName: app?.name ?? app?.slug ?? l.appId,
    kind: l.kind ?? "",
    termLabel: app?.terms.find((t) => t.kind === l.kind)?.label ?? null,
    issuer: l.issuer ?? "PUBLISHER_GRANT",
    status: l.status,
    start: l.start,
    end: l.end,
    mode,
    environmentId: envRow?.environment_id ?? null,
    environmentLabel: dedicated ? (envRow?.label ?? (await deps.grants.chainLabel(root))) : null,
    openUrl,
    stoppedAt: envRow?.stopped_at ?? null,
    deleteAfter: envRow?.delete_after ?? null,
    warnings: subscriptionWarnings(
      {
        status: l.status,
        end: l.end,
        mode,
        endedAt: envRow?.ended_at ?? null,
        stoppedAt: envRow?.stopped_at ?? null,
        deleteAfter: envRow?.delete_after ?? null,
      },
      deps.now(),
    ),
  };
}

/**
 * The owner surface (contract § vetraSubscriptions). "Mine" is decided by the
 * grant rows: a licence is the caller's when its grant row's holder is the
 * caller's normalised DID, whatever its document says. Statuses and ends are
 * the recorded lifecycle's.
 */
export function createSubscriptionResolvers(deps: SubscriptionDeps): Record<string, unknown> {
  const did = (ctx: Ctx): string => {
    const d = callerDid(ctx);
    if (!d) throw new UnauthenticatedError("sign in with Renown");
    return d;
  };
  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };

  /** One of the caller's licences, by its grant row; anyone else's fails like a missing one. */
  const owned = async (licenseId: string, caller: string): Promise<AuthorisedLicence> => {
    const grant = await deps.grants.grantFor(licenseId);
    if (!grant || grant.userDid !== caller) throw new UnknownLicenseError();
    // Absent when its document is missing or unreadable.
    const l = (await authorisedLicences(deps, [grant])).at(0);
    if (!l) throw new UnknownLicenseError();
    return l;
  };

  /**
   * The newest licence of each of the caller's chains. A live one is always
   * listed; an ended one while its chain's environment still exists (it is
   * offboarding: the warnings apply) and otherwise for DESTROY_AFTER_DAYS
   * after it ended.
   */
  const mySubscriptions = async (caller: string): Promise<Subscription[]> => {
    const licences = await authorisedLicences(deps, await deps.grants.grantsForHolder(caller));
    const roots = await deps.grants.chainRootsFor(licences.map((l) => l.id));
    const heads = new Map<string, AuthorisedLicence>();
    // Oldest first, so the last one seen in a chain is its newest.
    for (const l of licences) heads.set(roots.get(l.id) ?? l.id, l);
    const now = deps.now();
    // One integrity-checked read per app, however many chains it has.
    const appCache = new Map<string, ReturnType<SubscriptionDeps["apps"]["app"]>>();
    const cached: SubscriptionDeps = {
      ...deps,
      apps: {
        app: (id) => {
          let p = appCache.get(id);
          if (!p) appCache.set(id, (p = deps.apps.app(id)));
          return p;
        },
      },
    };
    const out: Subscription[] = [];
    for (const [root, l] of heads) {
      const s = await subscriptionFor(cached, l, root);
      const offboarding = s.environmentId !== null;
      const recent = l.endedAt !== null && Date.parse(now) < Date.parse(addDays(l.endedAt, DESTROY_AFTER_DAYS));
      if (isLive(l.status) || offboarding || recent) out.push(s);
    }
    return out;
  };

  return {
    Query: { vetraSubscriptions: () => ({}) },
    Mutation: { vetraSubscriptions: () => ({}) },

    VetraSubscriptionsQueries: {
      // Public. Every way a code can be unusable (unknown, paused, expired,
      // used up, or its term/app unable to issue it) is the same answer.
      inviteCode: withCodes(async (a: { code: string }) => {
        const row = await getCode(deps.issuer.db, a.code);
        if (!row || !(await isUsable(deps.issuer.db, row, deps.now()))) return INVALID_CHECK;
        if (!(await deps.issuer.owners.findAppById(row.app_id))) return INVALID_CHECK;
        const app = await deps.apps.app(row.app_id);
        const resolved = app ? resolveKind(app, row.kind) : null;
        if (!app || !resolved?.ok) return INVALID_CHECK;
        if (resolved.term.status !== "ACTIVE" || !resolved.term.issuers.includes("INVITE_CODE")) {
          return INVALID_CHECK;
        }
        return {
          valid: true,
          appId: app.id,
          appName: app.name ?? app.slug ?? app.id,
          kind: row.kind,
          termLabel: resolved.term.label,
          mode: resolved.template.mode,
        };
      }),

      mySubscriptions: withCodes(async (_a: unknown, ctx) => mySubscriptions(did(ctx))),

      studioAccess: withCodes(async (_a: unknown, ctx) => studioAccess(deps.studio, did(ctx))),
    },

    VetraSubscriptionsMutations: {
      redeemInviteCode: withCodes(
        async (a: { input: { code: string; label?: string | null; upgrades?: string | null } }, ctx) => {
          const caller = did(ctx);
          const { licenseId } = await redeemInviteCode(deps.issuer, {
            code: a.input.code,
            user: caller,
            label: a.input.label ?? null,
            upgrades: a.input.upgrades ?? null,
            now: deps.now(),
          });
          const l = await owned(licenseId, caller);
          const root = (await deps.grants.chainRootsFor([l.id])).get(l.id) ?? l.id;
          return subscriptionFor(deps, l, root);
        },
      ),

      cancelSubscription: withCodes(async (a: { licenseId: string }, ctx) => {
        const caller = did(ctx);
        await owned(a.licenseId, caller);
        // The licence's own lock (issue.ts), as the publisher's revoke: an
        // upgrade or renewal in flight finishes first, and the status is
        // re-read under the lock.
        await withLicenceLock(a.licenseId, async () => {
          const l = await owned(a.licenseId, caller);
          if (!isLive(l.status)) {
            throw new OperationRejectedError(
              `licence ${l.id} is ${l.status}; only an ISSUED or ACTIVE licence can be cancelled`,
            );
          }
          await deps.licenseGateway.execute(l.id, [
            licenseActions.revokeLicense({ reason: "cancelled by the holder" }),
          ]);
        });
        return true;
      }),

      applyStudioKey: withCodes(async (a: { tenantId: string; secretNames: string[] }, ctx) => {
        const caller = did(ctx);
        if (!deps.secrets) return false;
        const key = await studioKeyForDid(deps.studio, caller);
        if (key === null) return false;
        // Stricter than VetraAccessCodes.applyInviteCodeSecret, which wrote
        // into any tenant: a tenant whose environment is known must be the
        // caller's. One not projected yet (the cold path writes the key right
        // after creating the environment) is allowed: nobody else's
        // environment can be reached by it.
        const owners = await deps.tenantOwners(a.tenantId);
        const address = addressOfDid(caller);
        if (owners.some((o) => o !== address)) {
          throw new ForbiddenError("this tenant is not one of your environments");
        }
        if (owners.length === 0) {
          deps.logger.info(
            `[licensing] studio key for ${caller} written to tenant ${a.tenantId}, not projected yet`,
          );
        }
        // Sequential: setSecret notifies the reconciler per write.
        for (const name of a.secretNames) await deps.secrets.setSecret(a.tenantId, name, key);
        // Per-env random secret gating vetra-cli's session-export endpoints (unchanged behaviour).
        await deps.secrets.setSecret(
          a.tenantId,
          "VETRA_SESSION_EXPORT_SECRET",
          randomBytes(32).toString("hex"),
        );
        return true;
      }),
    },
  };
}
