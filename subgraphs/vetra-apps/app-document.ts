import type { Action } from "document-model";
import type { Kysely } from "kysely";
import {
  connectRepository,
  setAppDetails,
  setIdentity,
  setPreviews,
  setProductionEnvironment,
  setStatus,
} from "../../document-models/vetra-app/v1/index.js";
import type { VetraAppsDB } from "./db/schema.js";
import type { AppRow } from "./repo.js";

/**
 * The reactor surface the app-document paths need. Kept narrow so the backfill
 * and the dual-write can be driven by a fake in tests.
 */
export interface AppDocStore {
  create(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  execute(id: string, actions: Action[]): Promise<unknown>;
}

export interface AppDocDeps {
  db: Kysely<VetraAppsDB>;
  docs: AppDocStore;
  logger: Pick<Console, "warn">;
}

/** An empty column is absent, not the string "null". */
const orNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

/** The actions that reproduce a row's facts in its document. */
export function appDocumentActions(row: AppRow): Action[] {
  return [
    setAppDetails({
      name: orNull(row.name),
      slug: orNull(row.slug),
      owner: orNull(row.owner_address),
    }),
    connectRepository({
      repositoryId: orNull(row.repository_id),
      fullName: orNull(row.repository_full_name),
      productionBranch: orNull(row.production_branch),
    }),
    setIdentity({
      did: orNull(row.identity_did),
      expiresAt: orNull(row.identity_expires_at),
    }),
    setPreviews({
      enabled: row.previews_enabled,
      limit: row.preview_limit,
      ttlDays: row.preview_ttl_days,
    }),
    setProductionEnvironment({
      environmentId: orNull(row.production_environment_id),
    }),
    setStatus({ status: row.status }),
  ] as Action[];
}

/**
 * Creates one document per app row, with the row's own id.
 *
 * The id is load-bearing: environments' VetraCloudAppLink.appId,
 * app_deployments.app_id and the live app_license_grants gate all resolve on
 * apps.id, so a fresh id would break them.
 *
 * DELETED rows are backfilled too. They are soft deletes kept forever, and
 * environments still reference them.
 *
 * A row whose document already exists is skipped untouched: it may carry
 * artifacts the row knows nothing about.
 */
export async function backfillAppDocuments(
  deps: AppDocDeps,
): Promise<{ created: number; skipped: number }> {
  const rows = await deps.db.selectFrom("apps").selectAll().execute();

  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      if (await deps.docs.exists(row.id)) {
        skipped++;
        continue;
      }
      await deps.docs.create(row.id);
      await deps.docs.execute(row.id, appDocumentActions(row));
      created++;
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] backfill of app ${row.id} failed: ${String(err)}`,
      );
    }
  }
  return { created, skipped };
}

/**
 * Mirrors an app change into its document. Best-effort by design: reads are
 * still served from the table in this step, so a reactor outage must not fail a
 * user's request. The drift reconciler is what notices.
 */
export async function mirrorAppToDocument(
  deps: AppDocDeps,
  appId: string,
  actions: Action[],
): Promise<void> {
  try {
    await deps.docs.execute(appId, actions);
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] mirroring app ${appId} to its document failed: ${String(err)}`,
    );
  }
}
