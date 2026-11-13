import type { Action } from "document-model";
import { GraphQLError } from "graphql";
import {
  approveChanges,
  wakeEnvironment,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { withEnvLock, withKeyLock } from "../../../shared/key-lock.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import {
  expectOrgHandover,
  vetraServiceAddress,
} from "../../vetra-cloud-observability/env-protection.js";
import { gateConfigOf, instanceHealth, plansConfigOf } from "../config.js";
import {
  deleteGateToken,
  markGateDelivered,
  startGatePreviousGrace,
} from "../gate/repo.js";
import {
  ensureGateToken,
  GATE_PREVIOUS_GRACE_MS,
  GATE_TOKEN_ENV,
  withGate,
} from "../gate/service.js";
import { notConfigured } from "../errors.js";
import {
  hasCiIdentity,
  listPreviews,
  normalizeApp,
  type AppRow,
} from "../repo.js";
import type { ReleaseRow } from "../releases/repo.js";
import {
  deletePreviewsOfApp,
  PREVIEWS_FROM_INSTANCES,
  type AppsDeps,
} from "../service.js";
import { isPlanKind, syncPlanInstances } from "../plans/sync.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { getHold } from "../holds/repo.js";
import {
  appPodGone,
  holdEnvironment,
  releaseHold,
  rerender,
  workloadPodSeen,
} from "../holds/service.js";
import { instanceLabel, planInstanceLabel } from "./host.js";
import {
  declaredSecretNames,
  declaresVetraSecrets,
  envSettings,
  imageTag,
  instanceCreateActions,
  instanceUpdateActions,
  isInstanceRole,
  type InstanceImage,
} from "./render.js";
import { deliverSettings } from "../settings/deliver.js";
import { listAppSettings } from "../settings/repo.js";
import { settingsForKind, type InstanceSettings } from "../settings/resolve.js";
import {
  deleteInstance,
  getInstance,
  insertInstance,
  isHostUsed,
  listInstances,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "./repo.js";
import {
  healthView,
  observeEnvironment,
  observeHealth,
  UPDATE_TIMEOUT_MS,
} from "./status.js";
import { pullRequestGate } from "./pull-requests.js";
import {
  branchTargets,
  pickPreviews,
  previewCandidates,
  targetOf,
  type InstanceTarget,
} from "./targets.js";

export const INSTANCE_BASE_DOMAIN = "vetra.io";
/** removed_reason that keeps a tombstone (the branch may come back with newer builds). */
export const BRANCH_DELETED = "branch deleted";
const NOT_WANTED = "no longer wanted";
/**
 * reason of an instance being removed while its environment is still going: it
 * keeps environment_id (and its host) until the environment is DESTROYED or
 * gone, so a revive never makes a second environment on the same host.
 */
export const WAITING_FOR_ENV = "waiting for the environment to go";
/**
 * removed_reason of a closed (or merged) PR's preview: revived only by
 * reopening — the webhook, or (missed webhook) a build with a newer run than
 * its last target, after GitHub says the PR is open. A re-run keeps its run id.
 */
export const PR_CLOSED = "pull request closed";
/** removed_reason of a PR whose head is in another repository: never gets a preview. */
export const PR_FORK = "pull request from a fork";
/** removed_reason after a closed PR was reopened: revived like any other tombstone. */
export const PR_REOPENED = "pull request reopened";
/**
 * After the secrets were delivered to a fresh tenant, how long its first start waits (controller: ~1 s on notify).
 * Time-based, not confirmed: the chart's envFrom refs to <tenant>-env and <tenant>-secrets are optional,
 * so a pod started before the controller wrote them runs without them rather than waiting.
 */
export const SECRETS_SETTLE_MS = 30_000;
export const RECREATING_FOR_SETTINGS =
  "recreating the environment with Vetra's settings (it predates the secrets master key)";
/** A plan instance's data is the holder's: never recreated to get Vetra's master key. */
export const PLAN_NEEDS_NEW_SECRETS =
  "the environment predates Vetra's secrets master key; a plan instance keeps its data, so it is not recreated (needs an operator)";
export const NOT_A_PLAN_ENVIRONMENT =
  "the environment is not a PLAN instance; Vetra neither stops nor wakes it";
export const WAITING_FOR_NAMESPACE =
  "waiting for the environment's namespace to give it its secrets";
/** Failed, but retried each pass: it heals once the namespace appears. */
export const NAMESPACE_TIMED_OUT =
  "the environment's namespace did not come up within 20 minutes";
export const WAITING_FOR_SECRETS =
  "waiting for the environment's secrets to arrive";
/** reason when OpenBao fails a delivery; its detail goes to the log only. */
export const SECRETS_UNAVAILABLE = "secret storage unavailable";
export const AFTER_SETTINGS_CHANGE = "after a settings change";
/** Tombstones syncPreviewInstances never revives and the cap does not count. */
const FINAL = new Set<string>([PR_CLOSED, PR_FORK]);
const DAY_MS = 86_400_000;

export const previewName = (pr: number) => `pr-${pr}`;

const isNotConfigured = (err: unknown) =>
  err instanceof GraphQLError &&
  err.extensions.code === "SERVICE_NOT_CONFIGURED";

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * One pass over every App with instances: opted in, or with rows left to
 * remove. The kill switch (cfg.instances.enabled) stops it entirely. Only
 * environments the reconciler created are touched: the old deploy path,
 * licensed environments and gated rollouts never are.
 */
export async function reconcileInstancesOnce(deps: AppsDeps): Promise<void> {
  if (!deps.cfg.instances.enabled) return;
  const apps = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("instances_enabled", "=", true),
        eb("id", "in", eb.selectFrom("instances").select("app_id")),
      ]),
    )
    .execute();
  for (const raw of apps) {
    const app = normalizeApp(raw);
    try {
      await withKeyLock(`instances:${app.id}`, () => reconcileApp(deps, app));
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] instances of ${app.slug}: ${message(err)}`,
      );
    }
  }
}

/**
 * The 15-minute sweep (with the old path's preview sweeper): old-path
 * previews of apps on instances go, and every running preview is checked with
 * GitHub, so a missed pull_request.closed webhook (and staging, whose webhooks
 * go to production) does not keep a preview up until its TTL.
 */
export async function sweepInstancesOnce(deps: AppsDeps): Promise<void> {
  if (!deps.cfg.instances.enabled) return;
  const apps = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("instances_enabled", "=", true)
    .execute();
  for (const raw of apps) {
    const app = normalizeApp(raw);
    try {
      await withKeyLock(`instances:${app.id}`, () =>
        retireOldPreviews(deps, app),
      );
      await sweepClosedPreviews(deps, app);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] instance sweep of ${app.slug}: ${message(err)}`,
      );
    }
  }
}

/**
 * Running previews whose PR GitHub calls closed are marked like
 * markPullRequestClosed does. At most preview_limit GitHub calls per app;
 * "unknown" keeps the preview (and stops asking for this app this sweep).
 */
async function sweepClosedPreviews(deps: AppsDeps, app: AppRow): Promise<void> {
  if (!wantsPreviews(app)) return;
  const running = (await listInstances(deps.db, app.id, "preview")).filter(
    (r) => !r.removed_at,
  );
  for (const row of running.slice(0, app.preview_limit)) {
    const gate = await pullRequestGate(deps, app, row.pr!);
    if (gate === "unknown") return;
    if (gate === "closed") await markClosed(deps, app.id, row.id);
  }
}

async function reconcileApp(deps: AppsDeps, app: AppRow): Promise<void> {
  await syncBranchInstances(deps, app);
  await syncPreviewInstances(deps, app);
  const plans = plansConfigOf(deps.cfg);
  const gate = gateConfigOf(deps.cfg);
  if (plans.enabled && wantsInstances(app)) {
    try {
      await syncPlanInstances(deps, app);
    } catch (err) {
      // Licensing's tables may not exist yet (boot order); branch and preview instances go on.
      deps.logger.warn(
        `[vetra-apps] plan instances of ${app.slug}: ${message(err)}`,
      );
    }
    try {
      // Before the rows are read: a target a step moves is applied in this pass.
      await advanceRollouts(deps, app);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] rollouts of ${app.slug}: ${message(err)}`);
    }
  }
  // Read once per pass: every instance of a kind gets the same revision.
  const settingRows = await listAppSettings(deps.db, app.id);
  const rows = await listInstances(deps.db, app.id);
  // Removals first: an evicted preview frees its place before a new one is
  // created (spec 14.13). Array.prototype.sort is stable.
  rows.sort((a, b) => Number(!a.removed_at) - Number(!b.removed_at));
  for (const row of rows) {
    if (isPlanKind(row.kind) && !plans.enabled) continue;
    try {
      let settings = settingsForKind(settingRows, row.kind);
      // The licence gate (releases phase 3 slice 5): shared instances only.
      if (gate.enabled && gate.url && row.kind === "shared" && !row.removed_at)
        settings = withGate(settings, {
          appId: app.id,
          url: gate.url,
          token: await ensureGateToken(deps, row),
        });
      await reconcileInstance(deps, app, row, settings);
    } catch (err) {
      // One bad instance never stops the others.
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${row.name}: ${message(err)}`,
      );
      try {
        const reason = message(err);
        // Only when it changed (re-read: the pass may have patched it before
        // throwing): a lasting error does not rewrite the row each pass.
        const now = await getInstance(deps.db, row.id);
        if (now && (now.status !== "failed" || now.reason !== reason))
          await patch(deps, row, { status: "failed", reason });
      } catch (e) {
        deps.logger.warn(
          `[vetra-apps] instance ${app.slug}/${row.name}: ${message(e)}`,
        );
      }
    }
  }
}

function wantsInstances(app: AppRow): boolean {
  return (
    Boolean(app.instances_enabled) &&
    app.status !== "DELETED" &&
    hasCiIdentity(app)
  );
}

function wantsPreviews(app: AppRow): boolean {
  return wantsInstances(app) && app.previews_enabled;
}

/**
 * An app on instances has no old-path previews (overview slice 2): they are
 * deleted through deletePreview, which only deletes this app's PREVIEW
 * documents and marks their deployments SUPERSEDED.
 */
async function retireOldPreviews(deps: AppsDeps, app: AppRow): Promise<void> {
  if (!wantsInstances(app)) return;
  if ((await listPreviews(deps.db, app.id)).length === 0) return;
  await deletePreviewsOfApp(deps, app, PREVIEWS_FROM_INSTANCES);
}

const patch = (deps: AppsDeps, row: InstanceRow, p: InstancePatch) =>
  updateInstance(deps.db, row.id, p, deps.now().toISOString());

/** ADMINS per kind (spec section 5): an override (Team: the org's admins), the holder of an own instance, else the App owner. */
export function adminsOf(app: AppRow, row: InstanceRow): string {
  if (row.admins_override) return row.admins_override;
  return row.kind === "own" && row.holder_address
    ? row.holder_address
    : app.owner_address;
}

const sizeOf = (row: InstanceRow) =>
  (row.target_size ?? null) as Parameters<typeof instanceUpdateActions>[5];

/**
 * The reason a plan instance woken from a sleep gets: an earlier version
 * stopped plan instances by sleeping them (STOPPED, global.disabled), which
 * removes the CNPG cluster and its database.
 */
export const STOPPED_BY_SLEEP =
  "stopped by sleep before holds existed: the database was re-created empty";

/** The tenant (namespace) of an environment. */
async function tenantOf(
  deps: AppsDeps,
  envId: string,
  state: VetraCloudEnvironmentState,
  row: InstanceRow,
): Promise<string> {
  return (
    (deps.envTenant ? await deps.envTenant(envId) : null) ??
    getTenantId(state.genericSubdomain ?? row.host!, envId)
  );
}

/**
 * A plan instance Vetra wants stopped (licence ended, plan retired): its
 * environment is held (no app pod, no ingress; its database, backups and
 * /data stay) and the row is stopped once its app pod is gone. Never slept:
 * sleeping (STOPPED) removes the CNPG cluster, and with it the holder's
 * database. Nothing is deleted.
 */
async function stopPlanInstance(
  deps: AppsDeps,
  row: InstanceRow,
): Promise<void> {
  const reason = row.stop_reason!;
  if (!row.environment_id) {
    if (row.status !== "stopped" || row.reason !== reason)
      await patch(deps, row, { status: "stopped", reason });
    return;
  }
  const envId = row.environment_id;
  await withEnvLock(envId, async () => {
    const state = await deps.envs.getState(envId);
    if (!state || !ours(state, row)) return;
    if (state.app?.role !== "PLAN") {
      if (row.reason !== NOT_A_PLAN_ENVIRONMENT)
        await patch(deps, row, { reason: NOT_A_PLAN_ENVIRONMENT });
      return;
    }
    if (state.status === "STOPPED") {
      // Slept by an earlier version (its database is gone already): left stopped.
      if (row.status !== "stopped" || row.reason !== reason)
        await patch(deps, row, {
          status: "stopped",
          reason,
          ...(row.status !== "stopped" ? { stopped_by_vetra: true } : {}),
        });
      return;
    }
    // Recorded before holding: a crash in between must not leave a hold that
    // a renewal never releases.
    if (!row.stopped_by_vetra)
      row = await patch(deps, row, { stopped_by_vetra: true });
    const tenant = await tenantOf(deps, envId, state, row);
    const { created } = await holdEnvironment(deps, {
      environmentId: envId,
      reason,
      switchoverId: null,
      by: AUDIT_SYSTEM_ACTOR,
    });
    if (
      !created &&
      state.status === "READY" &&
      (await workloadPodSeen(deps, tenant))
    ) {
      // Held, deployed, and the app still runs: the held render never
      // happened (a crash between the hold and its render).
      await rerender(deps.envs, envId);
      return;
    }
    if (await appPodGone(deps, tenant)) {
      if (row.status !== "stopped" || row.reason !== reason)
        await patch(deps, row, { status: "stopped", reason });
      return;
    }
    const waiting = `${reason}: stopped once its app is gone (${state.status})`;
    if (row.reason !== waiting) await patch(deps, row, { reason: waiting });
  });
}

/** A fresh start: nothing runs, nothing failed. */
const CLEAN: InstancePatch = {
  running_version: null,
  running_digest: null,
  running_repository: null,
  running_degraded: null,
  failed_digest: null,
  health: null,
  health_check: null,
  health_reason: null,
  health_checked_at: null,
  health_since: null,
  health_digest: null,
  health_restarts: null,
  observed_digest: null,
  observed_digest_source: null,
  running_settings: null,
  failed_settings: null,
  settings_delivered: null,
  settings_delivered_at: null,
  health_settings: null,
  observed_settings: null,
};

/** A failed target is not retried until its digest or its settings revision changes. */
const failedOn = (row: InstanceRow, settings: InstanceSettings) =>
  row.failed_digest === row.target_digest &&
  (row.failed_settings ?? null) === settings.revision;

const failure = (
  row: InstanceRow,
  settings: InstanceSettings,
): InstancePatch => ({
  failed_digest: row.target_digest,
  failed_settings: settings.revision,
});

async function waitFor(
  deps: AppsDeps,
  row: InstanceRow,
  reason: string,
): Promise<void> {
  if (row.status !== "updating" || row.reason !== reason)
    await patch(deps, row, { status: "updating", reason });
}

/**
 * The environment is gone or going for good: its tenant's secrets go too (the
 * master key is kept by the purge), and with them a shared instance's gate
 * token, so the next pass issues a fresh one.
 */
async function forgetTenant(deps: AppsDeps, row: InstanceRow): Promise<void> {
  if (!row.host || !row.environment_id || !deps.instanceSecrets) return;
  await deps.instanceSecrets.purgeTenant(
    getTenantId(row.host, row.environment_id),
  );
  if (row.kind === "shared") await deleteGateToken(deps.db, row.id);
}

/** Rows for the wanted branch instances; targets moved; unwanted ones marked for removal. */
export async function syncBranchInstances(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const wanted: Map<string, ReleaseRow> = wantsInstances(app)
    ? await branchTargets(deps.db, app)
    : new Map<string, ReleaseRow>();
  const rows = await listInstances(deps.db, app.id, "branch");
  const nowIso = deps.now().toISOString();
  for (const [branch, release] of wanted) {
    let target: InstanceTarget;
    try {
      target = targetOf(release);
    } catch (err) {
      // One bad release never stalls the App's other branches or removals.
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${branch}: ${message(err)}`,
      );
      continue;
    }
    const row = rows.find((r) => r.name === branch);
    if (!row) {
      await insertInstance(deps.db, {
        id: deps.newId(),
        app_id: app.id,
        kind: "branch",
        name: branch,
        branch,
        pr: null,
        host: null,
        environment_id: null,
        ...target,
        running_version: null,
        running_digest: null,
        running_repository: null,
        status: "pending",
        reason: null,
        failed_digest: null,
        update_started_at: null,
        removed_at: null,
        removed_reason: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      continue;
    }
    if (row.removed_at) {
      // A deleted branch comes back only with a build newer than its last target.
      if (
        row.removed_reason === BRANCH_DELETED &&
        row.status === "removed" &&
        target.target_run! > (row.target_run ?? 0)
      )
        await patch(deps, row, {
          ...target,
          ...CLEAN,
          removed_at: null,
          removed_reason: null,
          status: "pending",
          reason: null,
        });
      continue;
    }
    if (
      row.target_digest !== target.target_digest ||
      row.target_version !== target.target_version ||
      row.target_repository !== target.target_repository ||
      row.target_ph_host !== target.target_ph_host
    )
      await patch(deps, row, target);
  }
  for (const row of rows) {
    if (!wanted.has(row.name) && !row.removed_at)
      await patch(deps, row, {
        removed_at: nowIso,
        removed_reason: NOT_WANTED,
      });
  }
}

/**
 * Rows for the wanted preview instances (spec section 5: one per open PR, on
 * that PR's newest build; 14.13: at most preview_limit, none after
 * preview_ttl_days without a build). A new or returning preview is created
 * only once GitHub says its PR is open and from the app's repository. Preview
 * rows are kept as tombstones (removeInstance): a closed PR's stays closed
 * until reopened, and a returning preview gets its old host back. Tombstones
 * go when their PR has no build within the TTL any more.
 */
export async function syncPreviewInstances(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const rows = await listInstances(deps.db, app.id, "preview");
  const since = new Date(
    deps.now().getTime() - app.preview_ttl_days * DAY_MS,
  ).toISOString();
  const candidates = await previewCandidates(deps.db, app.id, since);
  const newestRun = new Map(candidates.map((r) => [r.pr!, r.run]));
  // A closed PR's tombstone is asked about again only once a newer run
  // arrives: the workflow runs on `reopened`.
  const final = (r: InstanceRow) =>
    !!r.removed_reason &&
    FINAL.has(r.removed_reason) &&
    !(
      r.removed_reason === PR_CLOSED &&
      (newestRun.get(r.pr!) ?? 0) > (r.target_run ?? 0)
    );
  const excluded = new Set(rows.filter(final).map((r) => r.pr!));
  // PRs left out for this pass only: GitHub could not say (or was not asked),
  // or the build cannot be run. They hold no place, so running previews stay.
  const skipped = new Set<number>();
  const pick = () =>
    wantsPreviews(app)
      ? pickPreviews(
          candidates,
          new Set([...excluded, ...skipped]),
          app.preview_limit,
        )
      : new Map<number, ReleaseRow>();
  let wanted = pick();
  const nowIso = deps.now().toISOString();
  const skip = (pr: number) => {
    skipped.add(pr);
    wanted = pick();
  };
  // After one "unknown" GitHub is not asked again this pass; and never more
  // than twice the limit (a run of closed PRs).
  let githubDown = false;
  let githubCalls = 0;
  const maxGithubCalls = 2 * app.preview_limit;

  // A PR left out here frees its place at once: pick again.
  const seen = new Set<number>();
  let next: [number, ReleaseRow] | undefined;
  while ((next = [...wanted].find(([pr]) => !seen.has(pr)))) {
    const [pr, release] = next;
    seen.add(pr);
    const row = rows.find((r) => r.pr === pr);
    let target: InstanceTarget;
    try {
      target = targetOf(release);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${previewName(pr)}: ${message(err)}`,
      );
      // A running preview keeps its place (and its last good target).
      if (!row || row.removed_at) skip(pr);
      continue;
    }
    if (row && !row.removed_at) {
      if (
        row.target_digest !== target.target_digest ||
        row.target_version !== target.target_version ||
        row.target_repository !== target.target_repository ||
        row.target_ph_host !== target.target_ph_host
      )
        await patch(deps, row, target);
      continue;
    }
    // Still being removed: wait until its environment is gone.
    if (row && row.status !== "removed") continue;

    if (githubDown || githubCalls >= maxGithubCalls) {
      skip(pr);
      continue;
    }
    githubCalls++;
    const gate = await pullRequestGate(deps, app, pr);
    if (gate === "unknown") {
      githubDown = true;
      skip(pr);
      continue;
    }
    if (gate !== "open") {
      const reason = gate === "fork" ? PR_FORK : PR_CLOSED;
      // The run asked about becomes the tombstone's target: asked once per run.
      if (row)
        await patch(deps, row, { ...target, reason, removed_reason: reason });
      else
        await insertInstance(deps.db, {
          ...previewRow(deps, app, pr, target, nowIso),
          status: "removed",
          reason,
          removed_at: nowIso,
          removed_reason: reason,
        });
      excluded.add(pr);
      wanted = pick();
      continue;
    }
    if (row)
      await patch(deps, row, {
        ...target,
        ...CLEAN,
        environment_id: null,
        removed_at: null,
        removed_reason: null,
        status: "pending",
        reason: null,
      });
    else
      await insertInstance(deps.db, previewRow(deps, app, pr, target, nowIso));
  }

  const recent = new Set(candidates.map((r) => r.pr));
  for (const row of rows) {
    if (row.status === "removed") {
      if (!recent.has(row.pr)) await deleteInstance(deps.db, row.id);
      continue;
    }
    if (!row.removed_at && !wanted.has(row.pr!))
      await patch(deps, row, {
        removed_at: nowIso,
        removed_reason: NOT_WANTED,
      });
  }
}

function previewRow(
  deps: AppsDeps,
  app: AppRow,
  pr: number,
  target: InstanceTarget,
  nowIso: string,
) {
  return {
    id: deps.newId(),
    app_id: app.id,
    kind: "preview" as const,
    name: previewName(pr),
    branch: null,
    pr,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending" as const,
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function targetImage(row: InstanceRow): InstanceImage {
  return {
    repository: row.target_repository!,
    tag: imageTag(row.target_version!, row.target_digest!),
    phHost: row.target_ph_host!,
  };
}

/** This App's environment and no licence's (overview rule 1). */
export function ours(
  state: VetraCloudEnvironmentState,
  row: InstanceRow,
): boolean {
  return !state.managedBy && state.app?.appId === row.app_id;
}

async function apply(
  deps: AppsDeps,
  envId: string,
  actions: Action[],
): Promise<void> {
  const after = await deps.envs.execute(envId, actions);
  // Content first, APPROVE in its own call: a rejected action never ships half a batch.
  if (after.status === "CHANGES_PENDING" || after.status === "DRAFT")
    await deps.envs.execute(envId, [approveChanges({})]);
}

/**
 * Brings one instance a step closer to its target. Every environment write
 * runs under withEnvLock(envId), the lock org sync, organisation hand-overs
 * and ownership moves take; key order is instances:<appId> then the env id.
 * The lock is in-process: production runs one switchboard replica
 * (replicaCount: 1), so that suffices.
 */
export async function reconcileInstance(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  settings: InstanceSettings,
): Promise<void> {
  if (row.removed_at)
    return row.environment_id
      ? withEnvLock(row.environment_id, () => removeInstance(deps, row))
      : removeInstance(deps, row);
  if (row.stop_reason) return stopPlanInstance(deps, row);
  if (!row.target_digest) return;
  if (row.target_settings !== settings.revision) {
    await patch(deps, row, { target_settings: settings.revision });
    row = { ...row, target_settings: settings.revision };
  }
  if (!row.environment_id) {
    // A create that failed is not retried until a newer target (or settings) arrives.
    if (row.status === "failed" && failedOn(row, settings)) return;
    return createEnvironment(deps, app, row, settings);
  }
  const envId = row.environment_id;
  return withEnvLock(envId, () =>
    reconcileEnvironment(deps, app, row, envId, settings),
  );
}

/**
 * Environments on their way out: they still hold the instance's host, so the
 * instance waits until they are DESTROYED (or deleted) to get a new one.
 */
const GOING = new Set<VetraCloudEnvironmentState["status"]>([
  "TERMINATING",
  "ARCHIVED",
]);

/** A DRAFT this instance created: unlicensed, and not linked to anything else. */
const ownDraft = (state: VetraCloudEnvironmentState, row: InstanceRow) =>
  state.status === "DRAFT" &&
  !state.managedBy &&
  (!state.app || state.app.appId === row.app_id);

function revertImage(row: InstanceRow): InstanceImage | null {
  if (
    // It stopped serving after it ran healthy: going back would not help.
    row.running_degraded ||
    !row.running_digest ||
    !row.running_version ||
    row.running_digest === row.target_digest
  )
    return null;
  return {
    repository: row.running_repository ?? row.target_repository!,
    tag: imageTag(row.running_version, row.running_digest),
    phHost: row.target_ph_host!,
  };
}

const fusionVersion = (state: VetraCloudEnvironmentState) =>
  state.services.find((s) => s.type === "FUSION")?.version ?? null;

async function reconcileEnvironment(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  envId: string,
  settings: InstanceSettings,
): Promise<void> {
  const state = await deps.envs.getState(envId);
  if (state && GOING.has(state.status)) {
    // Left to finish, never reverted; recreated once it is gone.
    const reason = `waiting for the old environment (${state.status}) to go`;
    if (row.status !== "pending" || row.reason !== reason)
      await patch(deps, row, { status: "pending", reason });
    return;
  }
  if (!state || state.status === "DRAFT" || state.status === "DESTROYED") {
    // Deleted, destroyed, or a create that never got past its first batch:
    // start over.
    const own = !!state && ownDraft(state, row);
    if (own) await deps.envs.delete(envId);
    // Its tenant's secrets go with it (never those of a document that is not ours).
    if (!state || own || state.status === "DESTROYED")
      await forgetTenant(deps, row);
    await patch(deps, row, {
      ...CLEAN,
      environment_id: null,
      status: "pending",
      reason: "recreating the environment",
    });
    return;
  }
  if (!ours(state, row)) {
    deps.logger.warn(
      `[vetra-apps] instance ${app.slug}/${row.name}: environment ${envId} is not this App's instance any more; left alone`,
    );
    if (row.status !== "failed")
      await patch(deps, row, {
        status: "failed",
        reason:
          "the environment is not this App's instance any more; Vetra leaves it alone",
      });
    return;
  }
  if (state.status === "CHANGES_PENDING" && isInstanceRole(state)) {
    // Changes sent but never approved (a crash between the two calls).
    await deps.envs.execute(envId, [approveChanges({})]);
    return;
  }
  if (row.stopped_by_vetra && state.app?.role === "PLAN") {
    // Held by Vetra (licence ended, plan retired) and wanted again. A
    // switch-over's hold is the switch-over's to release.
    const hold = await getHold(deps.db, envId);
    if (hold && hold.switchover_id === null) {
      await releaseHold(deps, envId);
      await patch(deps, row, {
        status: "updating",
        reason: "starting again",
        stopped_by_vetra: false,
        update_started_at: deps.now().toISOString(),
      });
      return;
    }
    if (state.status === "STOPPED") {
      // Slept by an earlier version: its database went with the sleep.
      await apply(deps, envId, [wakeEnvironment({})]);
      await patch(deps, row, {
        status: "updating",
        reason: STOPPED_BY_SLEEP,
        stopped_by_vetra: false,
        update_started_at: deps.now().toISOString(),
      });
      return;
    }
    if (!hold) {
      if (
        await appPodGone(deps, await tenantOf(deps, envId, state, row))
      ) {
        // The hold went but its release's re-render did not happen (it
        // failed, or a crash in between): the held render is still in
        // place. Re-rendered before the flag is cleared, so a failure here
        // is retried on the next tick.
        await rerender(deps.envs, envId);
        await patch(deps, row, {
          status: "updating",
          reason: "starting again",
          stopped_by_vetra: false,
          update_started_at: deps.now().toISOString(),
        });
        return;
      }
      await patch(deps, row, { stopped_by_vetra: false });
    }
  }
  const admins = adminsOf(app, row);
  const size = sizeOf(row);

  if (!declaresVetraSecrets(state) && isPlanKind(row.kind)) {
    // Never deleted: a plan instance's data is the holder's.
    if (row.status !== "failed" || row.reason !== PLAN_NEEDS_NEW_SECRETS)
      await patch(deps, row, {
        status: "failed",
        reason: PLAN_NEEDS_NEW_SECRETS,
      });
    return;
  }
  if (!declaresVetraSecrets(state)) {
    // Made before slice 4: its host generated its own master key on an
    // ephemeral /data and its database keeps that key's fingerprint, so
    // Vetra's key would be refused. Branch and preview data are disposable:
    // start over (production has no instances yet).
    await deps.envs.delete(envId);
    await patch(deps, row, {
      status: "pending",
      reason: RECREATING_FOR_SETTINGS,
    });
    return;
  }

  // The tenant gets the revision's secrets before the document asks for it.
  const tenantId = getTenantId(state.genericSubdomain ?? row.host!, envId);
  let deliveredAt = row.settings_delivered_at;
  // Started once: its namespace exists (a STOPPED environment has no pods, so tenantLive says no).
  const started = fusionVersion(state) !== null;
  if (row.settings_delivered !== settings.revision) {
    if (deps.tenantLive && !started && !(await deps.tenantLive(tenantId))) {
      const since = Date.parse(row.update_started_at ?? "");
      if (deps.now().getTime() - since > UPDATE_TIMEOUT_MS) {
        // Not failure(): no failed target, so the wait goes on and heals.
        if (row.status !== "failed" || row.reason !== NAMESPACE_TIMED_OUT)
          await patch(deps, row, {
            status: "failed",
            reason: NAMESPACE_TIMED_OUT,
          });
        return;
      }
      return waitFor(deps, row, WAITING_FOR_NAMESPACE);
    }
    try {
      await deliverSettings(
        deps,
        tenantId,
        settings,
        declaredSecretNames(state),
      );
    } catch (err) {
      // Retried each pass (no failed target); the row changes only when the reason does.
      const reason = isNotConfigured(err) ? message(err) : SECRETS_UNAVAILABLE;
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${row.name}: delivering settings failed: ${message(err)}`,
      );
      if (row.status !== "failed" || row.reason !== reason)
        await patch(deps, row, { status: "failed", reason });
      return;
    }
    deliveredAt = deps.now().toISOString();
    await patch(deps, row, {
      settings_delivered: settings.revision,
      settings_delivered_at: deliveredAt,
    });
  }
  // The gate token reached the tenant. Also on later passes, so a crash
  // right after delivery heals (a no-op once marked). The previous token's
  // grace starts only once the environment runs these settings (below), so
  // a stalled rollout never locks out pods still on the old token.
  const gateSecret = settings.secrets.find((s) => s.name === GATE_TOKEN_ENV);
  const startGrace = async () => {
    if (gateSecret)
      await startGatePreviousGrace(
        deps.db,
        row.id,
        gateSecret.writeId,
        deps.now().toISOString(),
        GATE_PREVIOUS_GRACE_MS,
      );
  };
  if (gateSecret) {
    await markGateDelivered(
      deps.db,
      row.id,
      gateSecret.writeId,
      deliveredAt ?? deps.now().toISOString(),
    );
    // Heals a crash between observing the rollout and starting the grace.
    if (row.running_settings === settings.revision) await startGrace();
  }
  // A first start waits until the controller had time to write <tenant>-secrets.
  const start =
    started ||
    !deps.tenantLive ||
    deps.now().getTime() - Date.parse(deliveredAt ?? "") >= SECRETS_SETTLE_MS;
  if (!start) return waitFor(deps, row, WAITING_FOR_SECRETS);
  const want = envSettings(settings);

  const image = targetImage(row);
  if (failedOn(row, settings)) {
    // Not retried; but a revert that did not land is.
    const back = revertImage(row);
    if (back && fusionVersion(state) === image.tag) {
      const revert = instanceUpdateActions(
        state,
        back,
        admins,
        want,
        true,
        size,
      );
      if (revert.length > 0) await apply(deps, envId, revert);
    }
    return;
  }

  // Throws for anything that is not an instance (licensed, not a PREVIEW or PLAN).
  const updates = instanceUpdateActions(
    state,
    image,
    admins,
    want,
    start,
    size,
  );
  if (updates.length > 0) {
    await apply(deps, envId, updates);
    await patch(deps, row, {
      status: "updating",
      reason: null,
      update_started_at: deps.now().toISOString(),
    });
    return;
  }

  const health = instanceHealth(deps.cfg);
  // enforce: spec 14.7 health decides; report/off: slice 1's interim rule (health is only shown).
  const seen =
    health.mode === "enforce"
      ? observeHealth(
          state,
          {
            tag: image.tag,
            digest: row.target_digest!,
            settings: settings.revision,
          },
          row,
          healthView(row),
          deps.now(),
          health.unhealthyWindowMs,
        )
      : observeEnvironment(
          state,
          image.tag,
          row.update_started_at,
          deps.now(),
          !!row.running_digest &&
            row.running_digest === row.target_digest &&
            row.running_settings === settings.revision,
        );
  if (seen.kind === "unchanged") return;
  if (seen.kind === "ready") {
    if (
      row.status !== "ready" ||
      row.running_digest !== row.target_digest ||
      row.running_settings !== settings.revision ||
      row.running_degraded
    )
      await patch(deps, row, {
        status: "ready",
        reason: null,
        running_version: row.target_version,
        running_digest: row.target_digest,
        running_repository: row.target_repository,
        running_settings: settings.revision,
        running_degraded: false,
      });
    await startGrace();
    return;
  }
  if (seen.kind === "stopped" || seen.kind === "updating") {
    const reason = (seen.kind === "updating" && seen.reason) || null;
    if (row.status !== seen.kind || row.reason !== reason)
      await patch(deps, row, { status: seen.kind, reason });
    return;
  }
  if (seen.kind === "degraded") {
    // Surfaced, never reverted: nothing was updated, the target already ran healthy.
    if (
      row.status !== "degraded" ||
      row.reason !== seen.reason ||
      !row.running_degraded
    )
      await patch(deps, row, {
        status: "degraded",
        reason: seen.reason,
        running_degraded: true,
      });
    return;
  }
  // Failed: keep the target from being retried, and go back to what ran (spec section 6).
  const settingsOnly = row.running_digest === row.target_digest;
  // Null when only the settings changed: old secret values are not kept, nothing to go back to.
  const back = revertImage(row);
  // The revert goes back to the image only: new settings stay, say so.
  const kept =
    back && row.running_settings !== settings.revision
      ? ` (settings kept: ${settings.revision})`
      : "";
  await patch(deps, row, {
    status: "failed",
    reason: settingsOnly
      ? `${AFTER_SETTINGS_CHANGE}: ${seen.reason}`
      : `${seen.reason}${kept}`,
    ...failure(row, settings),
  });
  if (back) {
    const revert = instanceUpdateActions(state, back, admins, want, true, size);
    if (revert.length > 0) await apply(deps, envId, revert);
  }
}

const HOST_UNIQUE = "instances_host_uq";

function isHostConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return (
    e?.code === "23505" &&
    (e.constraint === HOST_UNIQUE || !!e.message?.includes(HOST_UNIQUE))
  );
}

/**
 * Claims the instance's host label on its row. The label is unique per App and
 * branch by construction (host.ts); one held elsewhere (exactly: an env's
 * subdomain or another instance's host), or a lost race on the unique index,
 * fails the instance instead of picking another.
 */
async function claimHost(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  settings: InstanceSettings,
): Promise<string | null> {
  if (row.host) return row.host;
  const host = isPlanKind(row.kind)
    ? planInstanceLabel(app, row, deps.cfg.instances.labelSuffix)
    : instanceLabel(app.id, app.slug, row.name, deps.cfg.instances.labelSuffix);
  const fail = (reason: string) =>
    patch(deps, row, { status: "failed", reason, ...failure(row, settings) });
  if ((await isHostUsed(deps.db, host)) || (await deps.subdomainUsed?.(host))) {
    await fail(`the host ${host} is taken`);
    return null;
  }
  try {
    await patch(deps, row, { host });
  } catch (err) {
    if (!isHostConflict(err)) throw err;
    deps.logger.warn(
      `[vetra-apps] instance ${app.slug}/${row.name}: host ${host} taken concurrently`,
    );
    await fail(`the host ${host} is taken`);
    return null;
  }
  return host;
}

async function createEnvironment(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  settings: InstanceSettings,
): Promise<void> {
  if (!deps.instanceSecrets)
    throw notConfigured("The tenant secrets store (OPENBAO_ADDR)");
  if (app.owner_org_id && !deps.orgHandoverDb && !isPlanKind(row.kind))
    throw notConfigured("The organisation hand-over store");
  if (!app.registry_namespace)
    throw new Error("the App has no registry namespace yet");
  const host = await claimHost(deps, app, row, settings);
  if (!host) return;
  const image = targetImage(row);
  const envId = await deps.envs.create();
  // Logged first, so an environment orphaned by a crash right here can be found.
  deps.logger.info(
    `[vetra-apps] instance ${app.slug}/${row.name}: created environment ${envId}`,
  );
  await withEnvLock(envId, async () => {
    if (!(await initEnvironment(deps, app, row, host, image, envId, settings)))
      return;
    // Without namespace knowledge (no tenantLive) nothing to wait for: deliver and start in this pass.
    if (!deps.tenantLive) {
      const fresh = await getInstance(deps.db, row.id);
      if (fresh?.environment_id === envId)
        await reconcileEnvironment(deps, app, fresh, envId, settings);
    }
  });
}

async function initEnvironment(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  host: string,
  image: InstanceImage,
  envId: string,
  settings: InstanceSettings,
): Promise<boolean> {
  // Recorded before any action: a crash leaves a DRAFT document the next pass deletes.
  await patch(deps, row, {
    host,
    environment_id: envId,
    status: "updating",
    reason: null,
    update_started_at: deps.now().toISOString(),
  });
  try {
    if (app.owner_org_id && !isPlanKind(row.kind))
      await expectOrgHandover(
        deps.orgHandoverDb!,
        envId,
        app.owner_org_id,
        deps.now(),
      );
    await apply(
      deps,
      envId,
      instanceCreateActions({
        label: `${app.name} · ${row.name}`,
        host,
        baseDomain: INSTANCE_BASE_DOMAIN,
        registry: isPlanKind(row.kind)
          ? deps.cfg.productionRegistry
          : deps.cfg.previewRegistry,
        // Plan instances: no person owns the document (overview D2, spec 14.5).
        owner: isPlanKind(row.kind)
          ? (deps.serviceOwner ?? vetraServiceAddress())
          : app.owner_address,
        ownerOrgId: isPlanKind(row.kind) ? null : app.owner_org_id,
        appId: app.id,
        gitRef: isPlanKind(row.kind)
          ? null
          : row.kind === "preview"
            ? `refs/pull/${row.pr}/head`
            : `refs/heads/${row.branch}`,
        prNumber: row.kind === "preview" ? row.pr : null,
        imageProject: app.registry_namespace!,
        image,
        admins: adminsOf(app, row),
        settings: envSettings(settings),
        // Started by reconcileEnvironment once its tenant has the secrets.
        start: false,
        role: isPlanKind(row.kind) ? "PLAN" : "PREVIEW",
        size: sizeOf(row),
      }),
    );
    return true;
  } catch (err) {
    // A rejected create would be rejected again: drop the half-made
    // environment and wait for a newer target.
    deps.logger.warn(
      `[vetra-apps] instance ${app.slug}/${row.name}: creating its environment failed: ${message(err)}`,
    );
    await deps.envs.delete(envId).catch(() => undefined);
    await patch(deps, row, {
      environment_id: null,
      status: "failed",
      reason: `creating the environment failed: ${message(err)}`,
      ...failure(row, settings),
    });
    return false;
  }
}

async function removeInstance(deps: AppsDeps, row: InstanceRow): Promise<void> {
  if (isPlanKind(row.kind))
    throw new Error(
      "plan instances are never removed by the reconciler (releases phase 3: stopped, not deleted)",
    );
  if (row.status === "removed") return;
  if (row.environment_id) {
    const envId = row.environment_id;
    let state = await deps.envs.getState(envId);
    // Only this App's unlicensed PREVIEW, or a DRAFT it created, is deleted;
    // and never again once it is on its way out.
    if (
      state &&
      !GOING.has(state.status) &&
      state.status !== "DESTROYED" &&
      ((ours(state, row) && state.app?.role === "PREVIEW") ||
        ownDraft(state, row))
    ) {
      await deps.envs.delete(envId);
      state = await deps.envs.getState(envId);
    }
    // Still going: it holds the host; the row (and its tombstone) waits.
    if (state && GOING.has(state.status)) {
      if (row.status !== "pending" || row.reason !== WAITING_FOR_ENV)
        await patch(deps, row, { status: "pending", reason: WAITING_FOR_ENV });
      return;
    }
    // Gone: its tenant's secrets go too (never those of a document that is not ours).
    if (!state || state.status === "DESTROYED") await forgetTenant(deps, row);
  }
  // Tombstones: a deleted branch (may come back with a newer build) and every
  // preview (a closed PR stays closed; a returning one keeps its host).
  if (row.kind === "preview" || row.removed_reason === BRANCH_DELETED)
    await patch(deps, row, {
      ...CLEAN,
      environment_id: null,
      status: "removed",
      reason: row.removed_reason,
    });
  else await deleteInstance(deps.db, row.id);
}

/** A branch was deleted on GitHub: its instance goes (spec section 5). Returns how many were marked. */
export async function markBranchDeleted(
  deps: AppsDeps,
  repositoryId: string,
  branch: string,
): Promise<number> {
  const rows = await deps.db
    .selectFrom("instances")
    .innerJoin("apps", "apps.id", "instances.app_id")
    .select("instances.id")
    .where("apps.repository_id", "=", repositoryId)
    .where("apps.instances_enabled", "=", true)
    .where("instances.kind", "=", "branch")
    .where("instances.name", "=", branch)
    .where("instances.removed_at", "is", null)
    .execute();
  const nowIso = deps.now().toISOString();
  for (const r of rows)
    await updateInstance(
      deps.db,
      r.id,
      { removed_at: nowIso, removed_reason: BRANCH_DELETED },
      nowIso,
    );
  return rows.length;
}

async function previewRowsOfPr(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<{ id: string; app_id: string }[]> {
  return deps.db
    .selectFrom("instances")
    .innerJoin("apps", "apps.id", "instances.app_id")
    .select(["instances.id", "instances.app_id"])
    .where("apps.repository_id", "=", repositoryId)
    .where("instances.kind", "=", "preview")
    .where("instances.pr", "=", pr)
    .execute();
}

/**
 * A PR was closed or merged: its preview goes (spec section 5) and stays
 * gone, whatever builds still arrive, until the PR is reopened. Runs under
 * the app's instances lock, so a reconciler pass cannot revive the row
 * concurrently. Returns how many rows were marked.
 */
export async function markPullRequestClosed(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<number> {
  const rows = await previewRowsOfPr(deps, repositoryId, pr);
  for (const r of rows) await markClosed(deps, r.app_id, r.id);
  return rows.length;
}

/** Marks one preview row closed, under the app's instances lock. */
async function markClosed(
  deps: AppsDeps,
  appId: string,
  id: string,
): Promise<void> {
  await withKeyLock(`instances:${appId}`, async () => {
    const nowIso = deps.now().toISOString();
    await deps.db
      .updateTable("instances")
      .set({ removed_at: nowIso, updated_at: nowIso })
      .where("id", "=", id)
      .where("removed_at", "is", null)
      .execute();
    await deps.db
      .updateTable("instances")
      .set({ removed_reason: PR_CLOSED, updated_at: nowIso })
      .where("id", "=", id)
      .execute();
  });
}

/** A closed PR was reopened: its preview may come back (after the GitHub check). */
export async function markPullRequestReopened(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<number> {
  let n = 0;
  for (const r of await previewRowsOfPr(deps, repositoryId, pr))
    await withKeyLock(`instances:${r.app_id}`, async () => {
      const nowIso = deps.now().toISOString();
      const res = await deps.db
        .updateTable("instances")
        .set({ removed_reason: PR_REOPENED, updated_at: nowIso })
        .where("id", "=", r.id)
        .where("removed_reason", "=", PR_CLOSED)
        .executeTakeFirst();
      n += Number(res.numUpdatedRows);
    });
  return n;
}
