import { UnauthenticatedError, type AuthContext } from "./auth.js";
import type {
  AppRollouts,
  EnvironmentUpdates,
  LicenseEnvironments,
} from "./db/schema.js";
import { callerDid } from "./did.js";
import type { LicensingConfig } from "./config.js";
import {
  toLicensingGraphQLError,
  UnknownEnvironmentError,
} from "./publisher-errors.js";
import {
  NotAppOwnerError,
  resolveOwnerApp,
  UnknownAppError,
  type PublisherAuthDeps,
} from "./publisher-auth.js";
import {
  environmentRelease,
  environmentUpdate,
  forceEnvironmentUpdate,
  promoteRelease,
  releaseCandidates,
  releaseSettings,
  requestUpdateNow,
  resumeRollout,
  rolloutsOf,
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
  type RolloutView,
} from "./release-service.js";
import { makeRequireEnabled } from "./resolvers.js";

export interface ReleaseResolverDeps extends ReleaseServiceDeps {
  auth: PublisherAuthDeps;
  cfg: Pick<LicensingConfig, "enabled">;
}

type Ctx = AuthContext & { isAdmin?: (a: string) => boolean };
type Opt<T> = T | null | undefined;

const rolloutOut = (r: AppRollouts | RolloutView) => ({
  id: r.id,
  artifactName: r.artifact_name,
  version: r.version,
  status: r.status,
  applyAfter: r.apply_after,
  promotedBy: r.promoted_by,
  promotedAt: r.promoted_at,
  pausedAt: r.paused_at,
  pausedReason: r.paused_reason,
  counts: "counts" in r ? r.counts : [],
});

const updateOut = (u: EnvironmentUpdates) => ({
  id: u.id,
  fromVersion: u.from_version,
  toVersion: u.to_version,
  status: u.status,
  dueAt: u.due_at,
  requestedAt: u.requested_at,
  startedAt: u.started_at,
  finishedAt: u.finished_at,
  error: u.error,
  createdAt: u.created_at,
});

/**
 * vetraReleases (releases-schema.ts). App fields: the app's owner, checked on
 * every call (resolveOwnerApp), and for writes the deployment switch after
 * it. Environment fields: its holder (the chain row's DID), or the owner of
 * its app; anyone else's environment fails like a missing one.
 */
export function createReleaseResolvers(
  deps: ReleaseResolverDeps,
): Record<string, unknown> {
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
  const owned = async (
    appId: string,
    ctx: Ctx,
    write: boolean,
  ): Promise<string> => {
    const { appId: id } = await resolveOwnerApp(deps.auth, ctx, appId);
    if (write) requireEnabled();
    return id;
  };
  const reachable = async (
    environmentId: string,
    ctx: Ctx,
    write: boolean,
  ): Promise<LicenseEnvironments> => {
    const did = callerDid(ctx);
    if (!did) throw new UnauthenticatedError("sign in with Renown");
    const row = await deps.envRows.byEnvironment(environmentId);
    if (!row) throw new UnknownEnvironmentError();
    // One spelling on both sides: the chain row's DID is normalised when the
    // licence is read (normaliseUserDid), callerDid lower-cases the address.
    if (row.user_did !== did) {
      try {
        await resolveOwnerApp(deps.auth, ctx, row.app_id);
      } catch (err) {
        if (err instanceof NotAppOwnerError || err instanceof UnknownAppError)
          throw new UnknownEnvironmentError();
        throw err;
      }
    }
    if (write) requireEnabled();
    return row;
  };

  /** One read of an environment's release fields per parent object (one request). */
  const releases = new WeakMap<object, ReturnType<typeof environmentRelease>>();
  const releaseOf = (p: { environmentId: string }) => {
    let r = releases.get(p);
    if (!r) releases.set(p, (r = environmentRelease(deps, p.environmentId)));
    return r;
  };
  /** releaseOf, with its failures masked like every other field's. */
  const released = async (p: { environmentId: string }) => {
    try {
      return await releaseOf(p);
    } catch (err) {
      throw toLicensingGraphQLError(err);
    }
  };

  return {
    Query: { vetraReleases: () => ({}) },
    Mutation: { vetraReleases: () => ({}) },

    VetraReleasesQueries: {
      releaseSettings: withCodes(async (a: { appId: string }, ctx) =>
        releaseSettings(deps, await owned(a.appId, ctx, false)),
      ),
      releaseCandidates: withCodes(async (a: { appId: string }, ctx) =>
        releaseCandidates(deps, await owned(a.appId, ctx, false)),
      ),
      rollouts: withCodes(async (a: { appId: string }, ctx) =>
        (await rolloutsOf(deps, await owned(a.appId, ctx, false))).map(
          rolloutOut,
        ),
      ),
      environmentUpdate: withCodes(
        async (a: { environmentId: string }, ctx) => {
          const view = await environmentUpdate(
            deps,
            (await reachable(a.environmentId, ctx, false)).environment_id,
          );
          return { open: view.open, history: view.history.map(updateOut) };
        },
      ),
    },

    VetraReleasesMutations: {
      setReleasePolicy: withCodes(
        async (
          a: {
            appId: string;
            policy: string;
            defaultNoticeHours?: Opt<number>;
          },
          ctx,
        ) =>
          setReleasePolicy(deps, {
            ...a,
            appId: await owned(a.appId, ctx, true),
          }),
      ),
      setCanaryEnvironment: withCodes(
        async (
          a: { appId: string; environmentId: string; canary: boolean },
          ctx,
        ) => {
          const appId = await owned(a.appId, ctx, true);
          // resolveOwnerApp already refused a caller without an address.
          const did = callerDid(ctx);
          if (!did) throw new UnauthenticatedError("sign in with Renown");
          return setCanaryEnvironment(deps, {
            appId,
            environmentId: a.environmentId,
            canary: a.canary,
            callerDid: did,
          });
        },
      ),
      promoteRelease: withCodes(
        async (
          a: {
            appId: string;
            artifactName: string;
            version: string;
            noticeHours?: Opt<number>;
          },
          ctx,
        ) => {
          const appId = await owned(a.appId, ctx, true);
          return rolloutOut(
            await promoteRelease(deps, {
              ...a,
              appId,
              promotedBy: ctx.user?.address ?? "",
            }),
          );
        },
      ),
      resumeRollout: withCodes(
        async (a: { appId: string; rolloutId: string }, ctx) =>
          resumeRollout(deps, {
            appId: await owned(a.appId, ctx, true),
            rolloutId: a.rolloutId,
          }),
      ),
      forceEnvironmentUpdate: withCodes(
        async (a: { appId: string; environmentId: string }, ctx) =>
          forceEnvironmentUpdate(deps, {
            appId: await owned(a.appId, ctx, true),
            environmentId: a.environmentId,
          }),
      ),
      updateEnvironmentNow: withCodes(
        async (a: { environmentId: string }, ctx) =>
          requestUpdateNow(deps, await reachable(a.environmentId, ctx, true)),
      ),
    },

    // Reached only through vetraPublisher.environments, which authorised the app.
    PublisherEnvironment: {
      runningVersion: async (p: { environmentId: string }) =>
        (await released(p)).runningVersion,
      isCanary: async (p: { environmentId: string }) =>
        (await released(p)).isCanary,
      update: async (p: { environmentId: string }) =>
        (await released(p)).update,
    },
  };
}
