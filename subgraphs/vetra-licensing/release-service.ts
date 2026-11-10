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
import type { AppLicensingWriter } from "./licensing-ledger.js";
import {
  AppTamperedError,
  ForbiddenError,
  InvalidPublisherInputError,
  OperationRejectedError,
  UnknownEnvironmentError,
  UnknownRolloutError,
} from "./publisher-errors.js";
import type { ReleaseSettings, RolloutStore } from "./rollout-db.js";

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

const POLICIES: readonly ReleasePolicy[] = ["AUTO", "GATED"];
const fusionVersionOf = (
  state: VetraCloudEnvironmentState | null,
): string | null =>
  state?.services.find((s) => s.type === "FUSION")?.version ?? null;
const isCanary = (row: LicenseEnvironments): boolean =>
  (row.channel_override ?? null) !== null;
const addHours = (iso: string, hours: number): string =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

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
  if (!app)
    throw new InvalidPublisherInputError(
      `app ${appId} has no readable document`,
    );
  if (app.tampered) throw new AppTamperedError(app.id);
  return app;
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
 * Sets the app's release policy (spec 4.1). GATED needs a live canary, and
 * points STAGING at LATEST's version for every FUSION image that has no
 * STAGING yet, so the canary keeps its image. `defaultNoticeHours` absent:
 * unchanged.
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
  const current = await deps.store.settings(input.appId);
  const next: ReleaseSettings = {
    appId: input.appId,
    policy,
    defaultNoticeHours:
      input.defaultNoticeHours === null ||
      input.defaultNoticeHours === undefined
        ? current.defaultNoticeHours
        : noticeHours(input.defaultNoticeHours),
  };
  if (policy === "GATED") {
    if ((await liveCanaries(deps, input.appId)).length === 0) {
      throw new OperationRejectedError(
        "mark one of your environments as a canary before gating releases",
      );
    }
    const app = await writableApp(deps, input.appId);
    const seed = app.artifacts.flatMap((a) => {
      const latest = a.channels.find((c) => c.channel === "LATEST");
      if (
        a.kind !== "FUSION_IMAGE" ||
        !latest ||
        a.channels.some((c) => c.channel === "STAGING")
      )
        return [];
      return [
        appActions.setArtifactChannel({
          kind: "FUSION_IMAGE",
          name: a.name,
          channel: "STAGING",
          version: latest.version,
        }),
      ];
    });
    if (seed.length > 0) await deps.appWriter.appendLicensingOps(app.id, seed);
  }
  await deps.store.saveSettings(next, deps.now());
  kick(deps);
  return next;
}

/**
 * Marks (or unmarks) a canary (spec 4.2): the caller's own environment of the
 * app, which then follows STAGING. The last canary of a GATED app cannot be
 * unmarked: its releases would have nowhere to go.
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
  const row = await envOf(deps, input.appId, input.environmentId);
  if (input.canary && row.user_did !== input.callerDid) {
    throw new ForbiddenError(
      "only an environment you hold yourself can be a canary",
    );
  }
  if (
    !input.canary &&
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
  kick(deps);
  return true;
}

/**
 * Promotes a version the canary runs to the app's customers (spec 4.3):
 * refused unless the app is GATED and a canary is READY on it; LATEST moves
 * to it, any ACTIVE or PAUSED rollout of the artifact is superseded, and the
 * customers are due `noticeHours` (default: the app's) from now.
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
  const settings = await deps.store.settings(input.appId);
  if (settings.policy !== "GATED") {
    throw new OperationRejectedError(
      "releases of this app are not gated: CI moves LATEST itself",
    );
  }
  const hours =
    input.noticeHours === null || input.noticeHours === undefined
      ? settings.defaultNoticeHours
      : noticeHours(input.noticeHours);
  const app = await writableApp(deps, input.appId);
  const artifact = app.artifacts.find(
    (a) => a.kind === "FUSION_IMAGE" && a.name === input.artifactName,
  );
  if (!artifact?.versions.some((v) => v.version === input.version)) {
    throw new InvalidPublisherInputError(
      `${input.artifactName} has no published version ${input.version}`,
    );
  }
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

/** PublisherEnvironment's release fields (spec 4.5). */
export async function environmentRelease(
  deps: ReleaseServiceDeps,
  environmentId: string,
) {
  const [row, state, update] = await Promise.all([
    deps.envRows.byEnvironment(environmentId),
    deps.envState(environmentId),
    deps.store.latest(environmentId),
  ]);
  return {
    runningVersion: fusionVersionOf(state),
    isCanary: row ? isCanary(row) : false,
    update: update && {
      status: update.status,
      toVersion: update.to_version,
      dueAt: update.due_at,
      error: update.error,
    },
  };
}
