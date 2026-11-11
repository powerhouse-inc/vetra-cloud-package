import type { Action } from "document-model";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { withEnvLock, withKeyLock } from "../../../shared/key-lock.js";
import { expectOrgHandover } from "../../vetra-cloud-observability/env-protection.js";
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
import { instanceLabel } from "./host.js";
import {
  imageTag,
  instanceCreateActions,
  instanceUpdateActions,
  type InstanceImage,
} from "./render.js";
import {
  deleteInstance,
  insertInstance,
  isHostUsed,
  listInstances,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "./repo.js";
import { observeEnvironment } from "./status.js";
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
/** Tombstones syncPreviewInstances never revives and the cap does not count. */
const FINAL = new Set<string>([PR_CLOSED, PR_FORK]);
const DAY_MS = 86_400_000;

export const previewName = (pr: number) => `pr-${pr}`;

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
  const rows = await listInstances(deps.db, app.id);
  // Removals first: an evicted preview frees its place before a new one is
  // created (spec 14.13). Array.prototype.sort is stable.
  rows.sort((a, b) => Number(!a.removed_at) - Number(!b.removed_at));
  for (const row of rows) {
    try {
      await reconcileInstance(deps, app, row);
    } catch (err) {
      // One bad instance never stops the others.
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${row.name}: ${message(err)}`,
      );
      try {
        await patch(deps, row, { status: "failed", reason: message(err) });
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

/** A fresh start: nothing runs, nothing failed. */
const CLEAN: InstancePatch = {
  running_version: null,
  running_digest: null,
  running_repository: null,
  failed_digest: null,
};

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
function ours(state: VetraCloudEnvironmentState, row: InstanceRow): boolean {
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
): Promise<void> {
  if (row.removed_at)
    return row.environment_id
      ? withEnvLock(row.environment_id, () => removeInstance(deps, row))
      : removeInstance(deps, row);
  if (!row.target_digest) return;
  if (!row.environment_id) {
    // A create that failed is not retried until a newer target arrives.
    if (row.status === "failed" && row.failed_digest === row.target_digest)
      return;
    return createEnvironment(deps, app, row);
  }
  const envId = row.environment_id;
  return withEnvLock(envId, () => reconcileEnvironment(deps, app, row, envId));
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
    if (state && ownDraft(state, row)) await deps.envs.delete(envId);
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
  if (state.status === "CHANGES_PENDING" && state.app?.role === "PREVIEW") {
    // Changes sent but never approved (a crash between the two calls).
    await deps.envs.execute(envId, [approveChanges({})]);
    return;
  }

  const image = targetImage(row);
  if (row.failed_digest === row.target_digest) {
    // Not retried; but a revert that did not land is.
    const back = revertImage(row);
    if (back && fusionVersion(state) === image.tag) {
      const revert = instanceUpdateActions(state, back, app.owner_address);
      if (revert.length > 0) await apply(deps, envId, revert);
    }
    return;
  }

  // Throws for anything that is not an instance (licensed, not a PREVIEW).
  const updates = instanceUpdateActions(state, image, app.owner_address);
  if (updates.length > 0) {
    await apply(deps, envId, updates);
    await patch(deps, row, {
      status: "updating",
      reason: null,
      update_started_at: deps.now().toISOString(),
    });
    return;
  }

  const seen = observeEnvironment(
    state,
    image.tag,
    row.update_started_at,
    deps.now(),
    !!row.running_digest && row.running_digest === row.target_digest,
  );
  if (seen.kind === "ready") {
    if (row.status !== "ready" || row.running_digest !== row.target_digest)
      await patch(deps, row, {
        status: "ready",
        reason: null,
        running_version: row.target_version,
        running_digest: row.target_digest,
        running_repository: row.target_repository,
      });
    return;
  }
  if (seen.kind === "stopped" || seen.kind === "updating") {
    if (row.status !== seen.kind)
      await patch(deps, row, { status: seen.kind, reason: null });
    return;
  }
  // Failed: keep the target from being retried, and go back to what ran (spec section 6).
  await patch(deps, row, {
    status: "failed",
    reason: seen.reason,
    failed_digest: row.target_digest,
  });
  const back = revertImage(row);
  if (back) {
    const revert = instanceUpdateActions(state, back, app.owner_address);
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
): Promise<string | null> {
  if (row.host) return row.host;
  const host = instanceLabel(
    app.id,
    app.slug,
    row.name,
    deps.cfg.instances.labelSuffix,
  );
  const fail = (reason: string) =>
    patch(deps, row, {
      status: "failed",
      reason,
      failed_digest: row.target_digest,
    });
  if (
    (await isHostUsed(deps.db, host)) ||
    (await deps.subdomainUsed?.(host))
  ) {
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
): Promise<void> {
  if (app.owner_org_id && !deps.orgHandoverDb)
    throw notConfigured("The organisation hand-over store");
  if (!app.registry_namespace)
    throw new Error("the App has no registry namespace yet");
  const host = await claimHost(deps, app, row);
  if (!host) return;
  const image = targetImage(row);
  const envId = await deps.envs.create();
  // Logged first, so an environment orphaned by a crash right here can be found.
  deps.logger.info(
    `[vetra-apps] instance ${app.slug}/${row.name}: created environment ${envId}`,
  );
  await withEnvLock(envId, () =>
    initEnvironment(deps, app, row, host, image, envId),
  );
}

async function initEnvironment(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  host: string,
  image: InstanceImage,
  envId: string,
): Promise<void> {
  // Recorded before any action: a crash leaves a DRAFT document the next pass deletes.
  await patch(deps, row, {
    host,
    environment_id: envId,
    status: "updating",
    reason: null,
    update_started_at: deps.now().toISOString(),
  });
  try {
    if (app.owner_org_id)
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
        registry: deps.cfg.previewRegistry,
        owner: app.owner_address,
        ownerOrgId: app.owner_org_id,
        appId: app.id,
        gitRef:
          row.kind === "preview"
            ? `refs/pull/${row.pr}/head`
            : `refs/heads/${row.branch}`,
        prNumber: row.kind === "preview" ? row.pr : null,
        imageProject: app.registry_namespace!,
        image,
        admins: app.owner_address,
      }),
    );
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
      failed_digest: row.target_digest,
    });
  }
}

async function removeInstance(deps: AppsDeps, row: InstanceRow): Promise<void> {
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
