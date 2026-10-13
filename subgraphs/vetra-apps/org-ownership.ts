import type { Kysely } from "kysely";
import {
  setOwner,
  setOwnerOrg,
} from "../../document-models/vetra-cloud-environment/v1/index.js";
import type { AccessCaller, OwnedResource } from "../../shared/org-access.js";
import type { AppPublisher } from "../../shared/renown-orgs.js";
import { withAppLock, withEnvLock } from "../../shared/key-lock.js";
import {
  expectOrgHandover,
  vetraServiceAddress,
} from "../vetra-cloud-observability/env-protection.js";
import type { Caller } from "./auth.js";
import { mirrorAppRow } from "./app-document.js";
import type { VetraAppsDB } from "./db/schema.js";
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
 * Who an App's vetra-app document is protected for: the Vetra service
 * identity for an organisation's App (as for its environments; nobody signs
 * as it), else the App's owner. vetra.io never reads or writes app documents
 * itself (everything goes through the subgraphs), so organisation members
 * need no grant on it.
 */
export function appDocumentOwner(
  row: Pick<AppRow, "owner_address" | "owner_org_id">,
  serviceOwner: string = vetraServiceAddress(),
): string {
  return row.owner_org_id
    ? serviceOwner.toLowerCase()
    : row.owner_address.toLowerCase();
}

/** The app-document protection owner of the `apps` row `id`, or null without a row. */
export function appDocumentRowOwner(
  db: Kysely<VetraAppsDB>,
  serviceOwner: string = vetraServiceAddress(),
): (id: string) => Promise<string | null> {
  return async (id) => {
    const row = await db
      .selectFrom("apps")
      .select(["owner_address", "owner_org_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? appDocumentOwner(row, serviceOwner) : null;
  };
}

/**
 * Bring one environment of an App in line with its owner / organisation.
 * The organisation move is announced (expectOrgHandover) inside the env lock
 * before it is dispatched, exactly as setEnvironmentOrg does, so the
 * observability protection hook keeps it instead of reverting it. Without a
 * hand-over store nothing is dispatched (it would be reverted): it throws,
 * and the caller leaves the App row as it is. An env that already matches is
 * left alone (no stray announcement); a missing document counts as moved.
 * Returns whether anything was dispatched.
 */
async function moveEnvironment(
  deps: AppsDeps,
  envId: string,
  nextOwner: string | null,
  nextOrg: string | null,
): Promise<boolean> {
  return withEnvLock(envId, async () => {
    let state;
    try {
      state = await deps.envs.getState(envId);
    } catch (err) {
      if (isDocumentNotFound(err)) return false;
      throw err;
    }
    if (!state) return false;
    const changeOwner =
      nextOwner !== null && state.owner?.toLowerCase() !== nextOwner;
    const changeOrg = (state.ownerOrgId ?? null) !== nextOrg;
    if (!changeOwner && !changeOrg) return false;
    if (changeOrg) {
      if (!deps.orgHandoverDb) {
        throw new Error(
          "no organisation hand-over store: the move could not be announced",
        );
      }
      // Wall-clock time: the observability hook checks it with its own clock.
      await expectOrgHandover(deps.orgHandoverDb, envId, nextOrg);
    }
    await deps.envs.execute(envId, [
      ...(changeOwner && nextOwner ? [setOwner({ address: nextOwner })] : []),
      ...(changeOrg
        ? [setOwnerOrg({ ownerOrgId: nextOrg, operators: [] })]
        : []),
    ]);
    return true;
  });
}

/** Where Renown says the App belongs, or null when that cannot be told. */
function targetOf(
  row: AppRow,
  publisher: AppPublisher,
): { org: string | null; owner: string } | null {
  const currentOrg = row.owner_org_id ?? null;
  const org = publisher.orgId ?? null;
  if (org || !currentOrg) return { org, owner: row.owner_address };
  // Only an org transfer hands an App to another person; without an address
  // there is nobody to hand it to.
  const to = publisher.address?.toLowerCase();
  return to ? { org: null, owner: to } : null;
}

/**
 * Reconcile the App's owner with its Renown profile's publisher (Ruling 11):
 * person → org sets owner_org_id, org → org changes it, org → person clears it
 * and hands the App to the profile's address. A personal App is never moved
 * to another person. No profile, no Renown client or a failed lookup:
 * unchanged.
 *
 * Runs under the App's lock and re-reads the row there, so racing reads move
 * an App once. The envs are reconciled on every sync with a profile — a move
 * the observability hook reverted is announced and made again — then the app
 * document's protection follows, then the row. When an env or the document
 * cannot be moved the row is left as it is, so the next read retries.
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
  const answer = publisher;
  return withAppLock(app.id, async () => {
    const row = (await getApp(deps.db, app.id)) ?? app;
    if (row.status === "DELETED") return row;
    const target = targetOf(row, answer);
    if (!target) return row;
    const currentOrg = row.owner_org_id ?? null;
    const ownerChanges = target.owner !== row.owner_address;
    const rowChanges = ownerChanges || target.org !== currentOrg;

    const envIds = [
      row.production_environment_id,
      ...(await listPreviews(deps.db, row.id)).map((p) => p.environment_id),
    ];
    for (const envId of envIds) {
      try {
        const moved = await moveEnvironment(
          deps,
          envId,
          ownerChanges ? target.owner : null,
          target.org,
        );
        if (moved && !rowChanges) {
          deps.logger.warn(
            `[vetra-apps] env ${envId} of App ${row.slug} did not match its App's owner; moved again`,
          );
        }
      } catch (err) {
        deps.logger.warn(
          `[vetra-apps] moving env ${envId} of App ${row.slug} failed (retried on the next read): ${String(err)}`,
        );
        return row;
      }
    }
    if (!rowChanges) return row;

    if (deps.protectAppDoc) {
      try {
        await deps.protectAppDoc(
          row.id,
          appDocumentOwner(
            { owner_address: target.owner, owner_org_id: target.org },
            deps.serviceOwner ?? vetraServiceAddress(),
          ),
        );
      } catch (err) {
        deps.logger.warn(
          `[vetra-apps] protecting the document of App ${row.slug} for its new owner failed (retried on the next read): ${String(err)}`,
        );
        return row;
      }
    }

    let update = deps.db
      .updateTable("apps")
      .set({
        owner_org_id: target.org,
        owner_address: target.owner,
        updated_at: deps.now().toISOString(),
      })
      .where("id", "=", row.id)
      .where("owner_address", "=", row.owner_address);
    update = currentOrg
      ? update.where("owner_org_id", "=", currentOrg)
      : update.where("owner_org_id", "is", null);
    await update.execute();
    const updated = await getApp(deps.db, row.id);
    if (!updated) return row;
    deps.logger.info(
      `[vetra-apps] App ${row.slug} is now owned by ${
        updated.owner_org_id
          ? `organisation ${updated.owner_org_id}`
          : updated.owner_address
      } (Renown)`,
    );
    await mirrorAppRow(deps, updated);
    return updated;
  });
}

/**
 * syncAppOrg over many rows, a few at a time (Renown answers are cached).
 * A row whose sync fails unexpectedly is returned as it was.
 */
export async function syncApps(
  deps: AppsDeps,
  rows: AppRow[],
  concurrency = 4,
): Promise<AppRow[]> {
  const out: AppRow[] = [...rows];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        out[i] = await syncAppOrg(deps, rows[i]);
      } catch (err) {
        deps.logger.warn(
          `[vetra-apps] ownership sync of App ${rows[i].slug} failed: ${String(err)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, worker),
  );
  return out;
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
  await syncApps(
    deps,
    rows.filter((r) => r.owner_org_id !== orgId).map(normalizeApp),
  );
}
