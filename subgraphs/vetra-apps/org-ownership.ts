import {
  setOwner,
  setOwnerOrg,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { AccessCaller, OwnedResource } from "../../shared/org-access.js";
import type { AppPublisher } from "../../shared/renown-orgs.js";
import { expectOrgHandover } from "../vetra-cloud-observability/env-protection.js";
import { withEnvLock } from "../vetra-cloud-observability/org-sync.js";
import type { Caller } from "./auth.js";
import { mirrorAppRow } from "./app-document.js";
import { isDocumentNotFound } from "./envs.js";
import { getApp, listPreviews, normalizeApp, type AppRow } from "./repo.js";
import type { AppsDeps } from "./service.js";

export const callerAccess = (c: Caller): AccessCaller => ({
  address: c.address,
  isAdmin: c.isAdmin,
});

export const appResource = (app: AppRow): OwnedResource => ({
  owner: app.owner_address,
  ownerOrgId: app.owner_org_id ?? null,
  appDid: app.identity_did,
});

/**
 * Move one environment of an App to its new owner / organisation. The
 * organisation move is announced (expectOrgHandover) inside the env lock
 * before it is dispatched, exactly as setEnvironmentOrg does, so the
 * observability protection hook keeps it instead of reverting it. An env that
 * already matches is left alone (no stray announcement). A missing document
 * counts as moved.
 */
async function moveEnvironment(
  deps: AppsDeps,
  envId: string,
  nextOwner: string | null,
  nextOrg: string | null,
): Promise<void> {
  await withEnvLock(envId, async () => {
    let state;
    try {
      state = await deps.envs.getState(envId);
    } catch (err) {
      if (isDocumentNotFound(err)) return;
      throw err;
    }
    if (!state) return;
    const changeOwner =
      nextOwner !== null && state.owner?.toLowerCase() !== nextOwner;
    const changeOrg = (state.ownerOrgId ?? null) !== nextOrg;
    if (!changeOwner && !changeOrg) return;
    if (changeOrg && deps.orgHandoverDb) {
      // Wall-clock time: the observability hook checks it with its own clock.
      await expectOrgHandover(deps.orgHandoverDb, envId, nextOrg);
    }
    await deps.envs.execute(envId, [
      ...(changeOwner && nextOwner ? [setOwner({ address: nextOwner })] : []),
      ...(changeOrg
        ? [setOwnerOrg({ ownerOrgId: nextOrg, operators: [] })]
        : []),
    ]);
  });
}

/**
 * Reconcile the App's owner with its Renown profile's publisher (Ruling 11):
 * person → org sets owner_org_id, org → org changes it, org → person clears it
 * and hands the App to the profile's address. A personal App is never moved
 * to another person. No profile, no Renown client or a failed lookup:
 * unchanged. The envs are moved first; when one of them cannot be moved the
 * row is left as it is, so the next read retries.
 */
export async function syncAppOrg(
  deps: AppsDeps,
  app: AppRow,
): Promise<AppRow> {
  if (!deps.orgs || app.status === "DELETED") return app;
  let publisher: AppPublisher | null;
  try {
    publisher = await deps.orgs.appPublisher(app.identity_did);
  } catch {
    return app;
  }
  if (!publisher) return app;
  const currentOrg = app.owner_org_id ?? null;
  const nextOrg = publisher.orgId ?? null;
  let nextOwner = app.owner_address;
  if (!nextOrg && currentOrg) {
    // Only an org transfer hands an App to another person; without an
    // address there is nobody to hand it to.
    const to = publisher.address?.toLowerCase();
    if (!to) return app;
    nextOwner = to;
  }
  if (nextOrg === currentOrg && nextOwner === app.owner_address) return app;

  const envIds = [
    app.production_environment_id,
    ...(await listPreviews(deps.db, app.id)).map((p) => p.environment_id),
  ];
  const ownerChanges = nextOwner !== app.owner_address;
  for (const envId of envIds) {
    try {
      await moveEnvironment(
        deps,
        envId,
        ownerChanges ? nextOwner : null,
        nextOrg,
      );
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] moving env ${envId} of App ${app.slug} failed (retried on the next read): ${String(err)}`,
      );
      return app;
    }
  }

  let update = deps.db
    .updateTable("apps")
    .set({
      owner_org_id: nextOrg,
      owner_address: nextOwner,
      updated_at: deps.now().toISOString(),
    })
    .where("id", "=", app.id)
    .where("owner_address", "=", app.owner_address);
  update = currentOrg
    ? update.where("owner_org_id", "=", currentOrg)
    : update.where("owner_org_id", "is", null);
  await update.execute();
  const updated = await getApp(deps.db, app.id);
  if (!updated) return app;
  deps.logger.info(
    `[vetra-apps] App ${app.slug} is now owned by ${
      updated.owner_org_id
        ? `organisation ${updated.owner_org_id}`
        : updated.owner_address
    } (Renown)`,
  );
  await mirrorAppRow(deps, updated);
  return updated;
}

/** Apps Renown lists for the org whose rows do not say so yet. */
export async function adoptOrgApps(
  deps: AppsDeps,
  orgId: string,
): Promise<void> {
  if (!deps.orgs) return;
  let dids: string[] | null;
  try {
    dids = await deps.orgs.orgApps(orgId);
  } catch {
    return;
  }
  if (!dids?.length) return;
  const rows = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("identity_did", "in", dids)
    .where("status", "!=", "DELETED")
    .execute();
  for (const row of rows) {
    if (row.owner_org_id !== orgId) await syncAppOrg(deps, normalizeApp(row));
  }
}
