import type { Action } from "document-model";
import { actions as appActions } from "document-models/vetra-app";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppDocView, AppReads } from "./app-reads.js";
import { CANARY_CHANNEL } from "./channel-override.js";
import type {
  AppRollouts,
  EnvironmentUpdates,
  LicenseEnvironments,
  ReleasePolicy,
  UpdateStatus,
} from "./db/schema.js";
import type { ChainEnvRows } from "./environments.js";
import { keyedMutex } from "./keyed-mutex.js";
import type { AppLicensingWriter } from "./licensing-ledger.js";
import { UnknownAppError } from "./publisher-auth.js";
import {
  AppTamperedError,
  ForbiddenError,
  InvalidPublisherInputError,
  OperationRejectedError,
  UnknownEnvironmentError,
  UnknownRolloutError,
} from "./publisher-errors.js";
import type { ReleaseSettings, RolloutStore } from "./rollout-db.js";
import { isFusionUpgrade } from "./template.js";
import type { AppArtifact } from "./reads.js";

/** The longest notice a promotion may give: 30 days. */
export const MAX_NOTICE_HOURS = 24 * 30;
/** How many past updates environmentUpdate returns. */
export const HISTORY_LIMIT = 20;

export interface ReleaseServiceDeps {
  store: RolloutStore;
  envRows: Pick<ChainEnvRows, "forApp" | "byEnvironment" | "update">;
  /** Ledger-checked app reads: a tampered app is refused. */
  apps: Pick<AppReads, "app">;
  /** The only route for app document writes (SET_ARTIFACT_CHANNEL): keeps the ledger valid. */
  appWriter: AppLicensingWriter;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  /** Asks the handler for a tick now; never throws. */
  kick?: () => void;
  newId(): string;
  now(): string;
}

/**
 * One release decision (policy, canary, promote) of an app at a time, so a
 * check and the write it justifies are never split by another caller's. In
 * process, as withChainLock and for the same reason: the subgraph runs as a
 * single replica. Not the store's lockApp transaction: each decision also
 * reads and writes licence rows and the app document on their own
 * connections, which wait forever behind an open transaction on a
 * one-connection database (PGlite, as in local development and the tests).
 */
const withAppRelease = keyedMutex();

const POLICIES: readonly ReleasePolicy[] = ["AUTO", "GATED"];
/**
 * The environment's FUSION version. The module assumes one FUSION image per
 * app template: the first FUSION service's version stands for the
 * environment's, which is what promote compares against the version.
 */
const fusionVersionOf = (
  state: VetraCloudEnvironmentState | null,
): string | null =>
  state?.services.find((s) => s.type === "FUSION")?.version ?? null;
const isCanary = (row: LicenseEnvironments): boolean =>
  (row.channel_override ?? null) !== null;
const addHours = (iso: string, hours: number): string =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
const pointerOf = (artifact: AppArtifact, channel: string): string | null =>
  artifact.channels.find((c) => c.channel === channel)?.version ?? null;
/** The artifact's recorded versions, newest last: what orders commit tags (isFusionUpgrade). */
const recordedOf = (artifact: AppArtifact): string[] =>
  artifact.versions.map((v) => v.version);

function noticeHours(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NOTICE_HOURS) {
    throw new InvalidPublisherInputError(
      `noticeHours must be a whole number from 0 to ${MAX_NOTICE_HOURS}`,
    );
  }
  return value;
}

async function writableApp(
  deps: ReleaseServiceDeps,
  appId: string,
): Promise<AppDocView> {
  const app = await deps.apps.app(appId);
  if (!app) throw new UnknownAppError("no such app");
  if (app.tampered) throw new AppTamperedError(app.id);
  return app;
}

/**
 * Brings STAGING up to LATEST on every FUSION image where it has no pointer
 * or LATEST is provably newer, so a canary that starts following STAGING
 * resolves its template and is not left behind. Never moves STAGING back,
 * nor where the order cannot be proven; an image without LATEST is left.
 */
async function bringStagingUp(
  deps: ReleaseServiceDeps,
  app: AppDocView,
): Promise<void> {
  const ops: Action[] = app.artifacts.flatMap((a) => {
    const latest = pointerOf(a, "LATEST");
    const staging = pointerOf(a, CANARY_CHANNEL);
    if (a.kind !== "FUSION_IMAGE" || latest === null) return [];
    if (staging !== null && !isFusionUpgrade(staging, latest, recordedOf(a)))
      return [];
    return [
      appActions.setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: a.name,
        channel: CANARY_CHANNEL,
        version: latest,
      }),
    ];
  });
  if (ops.length > 0) await deps.appWriter.appendLicensingOps(app.id, ops);
}

const liveCanaries = async (
  deps: ReleaseServiceDeps,
  appId: string,
): Promise<LicenseEnvironments[]> =>
  (await deps.envRows.forApp(appId)).filter(
    (r) => isCanary(r) && r.ended_at === null,
  );

/** The app's environment, or UnknownEnvironmentError: another app's fails like a missing one. */
async function envOf(
  deps: ReleaseServiceDeps,
  appId: string,
  environmentId: string,
): Promise<LicenseEnvironments> {
  const row = await deps.envRows.byEnvironment(environmentId);
  if (!row || row.app_id !== appId) throw new UnknownEnvironmentError();
  return row;
}

const kick = (deps: ReleaseServiceDeps) => {
  try {
    deps.kick?.();
  } catch {
    // A failed kick only means the next scheduled tick does it.
  }
};

export const releaseSettings = (
  deps: ReleaseServiceDeps,
  appId: string,
): Promise<ReleaseSettings> => deps.store.settings(appId);

/**
 * Sets the app's release policy (spec 4.1). GATED needs a live canary and
 * brings STAGING up to LATEST. Leaving GATED is refused while a rollout is
 * PAUSED, or ACTIVE with a PENDING or APPLYING update (AUTO would move every
 * held customer at once, past the notice and past a pause); an ACTIVE
 * rollout with nothing open (its stragglers cannot be provisioned now, say)
 * does not hold it. It unmarks the canaries: CI stops moving STAGING for an
 * AUTO app. `defaultNoticeHours` absent: unchanged.
 */
export async function setReleasePolicy(
  deps: ReleaseServiceDeps,
  input: { appId: string; policy: string; defaultNoticeHours?: number | null },
): Promise<ReleaseSettings> {
  const policy = POLICIES.find((p) => p === input.policy);
  if (!policy)
    throw new InvalidPublisherInputError(
      `policy must be one of ${POLICIES.join(", ")}`,
    );
  const hours =
    input.defaultNoticeHours === null || input.defaultNoticeHours === undefined
      ? null
      : noticeHours(input.defaultNoticeHours);
  const next = await withAppRelease(input.appId, async () => {
    const current = await deps.store.settings(input.appId);
    const next: ReleaseSettings = {
      appId: input.appId,
      policy,
      defaultNoticeHours: hours ?? current.defaultNoticeHours,
    };
    const leaving = policy === "AUTO" && current.policy === "GATED";
    if (policy === "GATED") {
      if ((await liveCanaries(deps, input.appId)).length === 0) {
        throw new OperationRejectedError(
          "mark one of your environments as a canary before gating releases",
        );
      }
      await bringStagingUp(deps, await writableApp(deps, input.appId));
    } else if (leaving) {
      for (const r of await deps.store.rolloutsOf(input.appId)) {
        if (r.status !== "ACTIVE" && r.status !== "PAUSED") continue;
        const release = `the release of ${r.artifact_name} ${r.version} (rollout ${r.id})`;
        if (r.status === "PAUSED") {
          throw new OperationRejectedError(
            `${release} is paused and must finish first`,
          );
        }
        const open = await deps.store.openCount(r.id);
        if (open > 0) {
          throw new OperationRejectedError(
            `${release} has ${open} ${open === 1 ? "update" : "updates"} still open and must finish first`,
          );
        }
      }
    }
    // Canaries first, AUTO last: an unmark that fails partway leaves the
    // app GATED, so a retry of the same call finishes the job.
    if (leaving) {
      for (const row of await deps.envRows.forApp(input.appId)) {
        if (!isCanary(row)) continue;
        await deps.envRows.update(row.environment_id, {
          channel_override: null,
          updated_at: deps.now(),
        });
      }
    }
    await deps.store.saveSettings(next, deps.now());
    return next;
  });
  kick(deps);
  return next;
}

/**
 * Marks (or unmarks) a canary (spec 4.2): the caller's own environment of the
 * app, which then follows STAGING (brought up to LATEST first). The last
 * canary of a GATED app cannot be unmarked: its releases would have nowhere
 * to go.
 */
export async function setCanaryEnvironment(
  deps: ReleaseServiceDeps,
  input: {
    appId: string;
    environmentId: string;
    canary: boolean;
    callerDid: string;
  },
): Promise<boolean> {
  await withAppRelease(input.appId, async () => {
    const row = await envOf(deps, input.appId, input.environmentId);
    if (input.canary && row.user_did !== input.callerDid) {
      throw new ForbiddenError(
        "only an environment you hold yourself can be a canary",
      );
    }
    if (input.canary) {
      await bringStagingUp(deps, await writableApp(deps, input.appId));
    } else if (
      isCanary(row) &&
      (await deps.store.settings(input.appId)).policy === "GATED"
    ) {
      const others = (await liveCanaries(deps, input.appId)).filter(
        (r) => r.environment_id !== row.environment_id,
      );
      if (others.length === 0) {
        throw new OperationRejectedError(
          "a gated app needs a canary: switch the policy to AUTO first, or mark another",
        );
      }
    }
    await deps.envRows.update(row.environment_id, {
      channel_override: input.canary ? CANARY_CHANNEL : null,
      updated_at: deps.now(),
    });
  });
  kick(deps);
  return true;
}

/**
 * Promotes a version the canary runs to the app's customers (spec 4.3):
 * refused unless the app is GATED, a canary is READY on it and it is not
 * provably older than LATEST (upgrades only move forward; LATEST's own
 * version may be promoted again); LATEST moves to it, any ACTIVE or PAUSED
 * rollout of the artifact is superseded, and the customers are due
 * `noticeHours` (default: the app's) from now.
 */
export async function promoteRelease(
  deps: ReleaseServiceDeps,
  input: {
    appId: string;
    artifactName: string;
    version: string;
    noticeHours?: number | null;
    promotedBy: string;
  },
): Promise<AppRollouts> {
  const given =
    input.noticeHours === null || input.noticeHours === undefined
      ? null
      : noticeHours(input.noticeHours);
  // Held across the document write on purpose: a second promotion must see
  // the LATEST this one set before it checks its own version against it.
  const rollout = await withAppRelease(input.appId, async () => {
    const settings = await deps.store.settings(input.appId);
    if (settings.policy !== "GATED") {
      throw new OperationRejectedError(
        "releases of this app are not gated: CI moves LATEST itself",
      );
    }
    const hours = given ?? settings.defaultNoticeHours;
    const app = await writableApp(deps, input.appId);
    const artifact = app.artifacts.find(
      (a) => a.kind === "FUSION_IMAGE" && a.name === input.artifactName,
    );
    if (!artifact?.versions.some((v) => v.version === input.version)) {
      throw new InvalidPublisherInputError(
        `${input.artifactName} has no published version ${input.version}`,
      );
    }
    const latest = pointerOf(artifact, "LATEST");
    if (
      latest !== null &&
      isFusionUpgrade(input.version, latest, recordedOf(artifact))
    ) {
      throw new OperationRejectedError(
        `${input.artifactName} ${input.version} is older than its LATEST ${latest}: releases only move forward`,
      );
    }
    // One FUSION image per template (fusionVersionOf): the canary's FUSION
    // version is its version of this artifact.
    let healthy = false;
    for (const canary of await liveCanaries(deps, app.id)) {
      const state = await deps.envState(canary.environment_id);
      if (state?.status === "READY" && fusionVersionOf(state) === input.version)
        healthy = true;
    }
    if (!healthy)
      throw new OperationRejectedError(
        `no canary environment of this app is READY on ${input.version}`,
      );

    // LATEST first: should the rollout insert then fail, customers wait (an
    // unpromoted version is held) and promoting again finishes it.
    await deps.appWriter.appendLicensingOps(app.id, [
      appActions.setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: input.artifactName,
        channel: "LATEST",
        version: input.version,
      }),
    ]);
    const now = deps.now();
    const rollout: AppRollouts = {
      id: deps.newId(),
      app_id: app.id,
      artifact_name: input.artifactName,
      version: input.version,
      status: "ACTIVE",
      apply_after: addHours(now, hours),
      promoted_by: input.promotedBy.toLowerCase(),
      promoted_at: now,
      paused_at: null,
      paused_reason: null,
    };
    await deps.store.promote(rollout);
    return rollout;
  });
  kick(deps);
  return rollout;
}

/** Resumes a PAUSED rollout; its FAILED updates are PENDING again (spec 4.3). */
export async function resumeRollout(
  deps: ReleaseServiceDeps,
  input: { appId: string; rolloutId: string },
): Promise<boolean> {
  const rollout = await deps.store.rollout(input.rolloutId);
  if (!rollout || rollout.app_id !== input.appId)
    throw new UnknownRolloutError();
  if (!(await deps.store.resume(rollout.id))) {
    throw new OperationRejectedError(
      `rollout ${rollout.id} is ${rollout.status}, not PAUSED`,
    );
  }
  kick(deps);
  return true;
}

/**
 * The publisher's force (spec 4.3): the environment's waiting (PENDING) or
 * FAILED update applies on the next tick, despite its deadline, a pause or a
 * version the floor cannot order; still one environment of the app at a
 * time, and never to a provably older version.
 */
export async function forceEnvironmentUpdate(
  deps: ReleaseServiceDeps,
  input: { appId: string; environmentId: string },
): Promise<boolean> {
  const row = await envOf(deps, input.appId, input.environmentId);
  const update = await deps.store.latest(row.environment_id);
  if (!update || (update.status !== "PENDING" && update.status !== "FAILED")) {
    throw new OperationRejectedError(
      "no update of this environment is waiting or failed",
    );
  }
  const now = deps.now();
  // Guarded: the update may have moved on since it was read. The stale
  // error goes; the gate writes a new reason should it hold the update again.
  const forced = await deps.store.transitionUpdate(
    update.id,
    ["PENDING", "FAILED"],
    {
      status: "PENDING",
      forced_at: now,
      requested_at: update.requested_at ?? now,
      started_at: null,
      finished_at: null,
      error: null,
    },
  );
  if (!forced) {
    throw new OperationRejectedError(
      "this environment's update is no longer waiting or failed",
    );
  }
  kick(deps);
  return true;
}

/** "Update now" (spec 4.3): the environment's PENDING update is due at once; refused while its rollout is paused. */
export async function requestUpdateNow(
  deps: ReleaseServiceDeps,
  row: LicenseEnvironments,
): Promise<boolean> {
  const update = await deps.store.latest(row.environment_id);
  if (update?.status !== "PENDING")
    throw new OperationRejectedError(
      "no update of this environment is waiting",
    );
  const rollout = update.rollout_id
    ? await deps.store.rollout(update.rollout_id)
    : null;
  if (rollout?.status === "PAUSED") {
    throw new OperationRejectedError(
      "this update is paused until the publisher resumes the release",
    );
  }
  if (update.requested_at === null)
    await deps.store.patchUpdate(update.id, { requested_at: deps.now() });
  kick(deps);
  return true;
}

export interface ReleaseCandidate {
  artifactName: string;
  staging: string | null;
  latest: string | null;
  canaries: {
    environmentId: string;
    version: string | null;
    status: string | null;
  }[];
}

/** Per FUSION image: STAGING, LATEST and what each canary runs (spec 4.5). */
export async function releaseCandidates(
  deps: ReleaseServiceDeps,
  appId: string,
): Promise<ReleaseCandidate[]> {
  const app = await deps.apps.app(appId);
  if (!app) return [];
  const canaries = await Promise.all(
    (await liveCanaries(deps, appId)).map(async (r) => {
      const state = await deps.envState(r.environment_id);
      return {
        environmentId: r.environment_id,
        version: fusionVersionOf(state),
        status: state?.status ?? null,
      };
    }),
  );
  return app.artifacts
    .filter((a) => a.kind === "FUSION_IMAGE")
    .map((a) => ({
      artifactName: a.name,
      staging: a.channels.find((c) => c.channel === "STAGING")?.version ?? null,
      latest: a.channels.find((c) => c.channel === "LATEST")?.version ?? null,
      canaries,
    }));
}

export type RolloutView = AppRollouts & {
  counts: { status: UpdateStatus; count: number }[];
};

/** The app's rollouts, newest first, with their updates counted by status. */
export async function rolloutsOf(
  deps: ReleaseServiceDeps,
  appId: string,
): Promise<RolloutView[]> {
  return Promise.all(
    (await deps.store.rolloutsOf(appId)).map(async (r) => ({
      ...r,
      counts: await deps.store.countsByStatus(r.id),
    })),
  );
}

export interface EnvironmentUpdateView {
  open: {
    toVersion: string;
    dueAt: string;
    status: UpdateStatus;
    canUpdateNow: boolean;
  } | null;
  history: EnvironmentUpdates[];
}

/** The holder's view (spec 4.5): the open update and the last HISTORY_LIMIT updates. */
export async function environmentUpdate(
  deps: ReleaseServiceDeps,
  environmentId: string,
): Promise<EnvironmentUpdateView> {
  const history = await deps.store.history(environmentId, HISTORY_LIMIT);
  const open =
    history.find((u) => u.status === "PENDING" || u.status === "APPLYING") ??
    null;
  const rollout = open?.rollout_id
    ? await deps.store.rollout(open.rollout_id)
    : null;
  return {
    open: open && {
      toVersion: open.to_version,
      dueAt: open.due_at,
      status: open.status,
      canUpdateNow:
        open.status === "PENDING" &&
        open.requested_at === null &&
        rollout?.status !== "PAUSED",
    },
    history,
  };
}

/**
 * PublisherEnvironment's release fields (spec 4.5), each from its own read
 * and each read at most once: `isCanary` (non-null) needs only the chain row,
 * so a document that cannot be read fails `runningVersion` alone and never
 * the whole environment list.
 */
export function environmentReleaseFields(
  deps: ReleaseServiceDeps,
  environmentId: string,
) {
  const once = <T>(read: () => Promise<T>) => {
    let p: Promise<T> | undefined;
    return () => (p ??= read());
  };
  return {
    runningVersion: once(async () =>
      fusionVersionOf(await deps.envState(environmentId)),
    ),
    isCanary: once(async () => {
      const row = await deps.envRows.byEnvironment(environmentId);
      return row ? isCanary(row) : false;
    }),
    update: once(async () => {
      const update = await deps.store.latest(environmentId);
      return (
        update && {
          status: update.status,
          toVersion: update.to_version,
          dueAt: update.due_at,
          error: update.error,
        }
      );
    }),
  };
}

/** All three of environmentReleaseFields at once. */
export async function environmentRelease(
  deps: ReleaseServiceDeps,
  environmentId: string,
) {
  const fields = environmentReleaseFields(deps, environmentId);
  const [runningVersion, isCanary, update] = await Promise.all([
    fields.runningVersion(),
    fields.isCanary(),
    fields.update(),
  ]);
  return { runningVersion, isCanary, update };
}
