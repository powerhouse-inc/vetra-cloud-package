import type { Action } from "document-model";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { withEnvLock, withKeyLock } from "../../../shared/key-lock.js";
import { expectOrgHandover } from "../../vetra-cloud-observability/env-protection.js";
import { notConfigured } from "../errors.js";
import { hasCiIdentity, normalizeApp, type AppRow } from "../repo.js";
import type { ReleaseRow } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";
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
import { branchTargets, targetOf, type InstanceTarget } from "./targets.js";

export const INSTANCE_BASE_DOMAIN = "vetra.io";
/** removed_reason that keeps a tombstone (the branch may come back with newer builds). */
export const BRANCH_DELETED = "branch deleted";
const NOT_WANTED = "no longer wanted";

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

async function reconcileApp(deps: AppsDeps, app: AppRow): Promise<void> {
  await syncBranchInstances(deps, app);
  for (const row of await listInstances(deps.db, app.id)) {
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

/** Environments that are going or gone: the instance gets a new one. */
const GONE = new Set<VetraCloudEnvironmentState["status"]>([
  "TERMINATING",
  "DESTROYED",
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
  if (!state || state.status === "DRAFT" || GONE.has(state.status)) {
    // Deleted, going away, or a create that never got past its first batch:
    // start over (a going environment is left to finish, never reverted).
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
        gitRef: `refs/heads/${row.branch}`,
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
    const state = await deps.envs.getState(row.environment_id);
    // Only this App's unlicensed PREVIEW, or a DRAFT it created, is deleted.
    if (
      state &&
      ((ours(state, row) && state.app?.role === "PREVIEW") ||
        ownDraft(state, row))
    )
      await deps.envs.delete(row.environment_id);
  }
  if (row.removed_reason === BRANCH_DELETED)
    await patch(deps, row, {
      ...CLEAN,
      environment_id: null,
      status: "removed",
      reason: BRANCH_DELETED,
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
