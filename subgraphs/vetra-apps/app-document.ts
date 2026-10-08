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
  /** Current global state, or null when the document does not exist. */
  getState(id: string): Promise<Record<string, unknown> | null>;
  /** Makes a document system-write-only; absent when permissions are off. */
  protect?: (id: string) => Promise<void>;
}

/**
 * Protects a document this process just created and populated. Best-effort: a
 * failure is logged, never thrown, so the populated document stays and the
 * licensing setup sweep re-protects it on the next boot.
 */
export async function protectNewAppDocument(
  docs: AppDocStore,
  id: string,
  logger: Pick<Console, "warn">,
): Promise<void> {
  if (!docs.protect) return;
  try {
    await docs.protect(id);
  } catch (err) {
    logger.warn(
      `[vetra-apps] protecting the document for app ${id} failed (the next sweep retries): ${String(err)}`,
    );
  }
}

export interface AppDocDeps {
  db: Kysely<VetraAppsDB>;
  docs: AppDocStore;
  logger: Pick<Console, "warn">;
}

/** An empty column is absent, not the string "null". */
const orNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

/**
 * Everything about an app that its document is supposed to carry.
 *
 * Both the dual-write and the drift reconciler derive from this one function,
 * so a field added to the mirror is automatically a field drift can see. Two
 * separate derivations would silently stop agreeing.
 */
export interface AppDocumentFacts {
  name: string | null;
  slug: string | null;
  owner: string | null;
  repository: {
    repositoryId: string | null;
    fullName: string | null;
    productionBranch: string | null;
  };
  identity: { did: string | null; expiresAt: string | null };
  previews: { enabled: boolean; limit: number; ttlDays: number };
  productionEnvironmentId: string | null;
  status: AppRow["status"];
}

/** The row's facts, in the shape the document holds them. */
export function appDocumentFacts(row: AppRow): AppDocumentFacts {
  return {
    name: orNull(row.name),
    slug: orNull(row.slug),
    owner: orNull(row.owner_address),
    repository: {
      repositoryId: orNull(row.repository_id),
      fullName: orNull(row.repository_full_name),
      productionBranch: orNull(row.production_branch),
    },
    identity: {
      did: orNull(row.identity_did),
      expiresAt: orNull(row.identity_expires_at),
    },
    previews: {
      enabled: Boolean(row.previews_enabled),
      limit: row.preview_limit,
      ttlDays: row.preview_ttl_days,
    },
    productionEnvironmentId: orNull(row.production_environment_id),
    status: row.status,
  };
}

/** The actions that reproduce a row's facts in its document. */
export function appDocumentActions(row: AppRow): Action[] {
  const facts = appDocumentFacts(row);
  return [
    setAppDetails({
      name: facts.name,
      slug: facts.slug,
      owner: facts.owner,
    }),
    connectRepository(facts.repository),
    setIdentity(facts.identity),
    setPreviews(facts.previews),
    setProductionEnvironment({
      environmentId: facts.productionEnvironmentId,
    }),
    setStatus({ status: facts.status }),
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
      await protectNewAppDocument(deps.docs, row.id, deps.logger);
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

/**
 * What the dual-write needs from `AppsDeps`. `docs` is optional: a deployment
 * with no reactor surface wired simply does not mirror, and every existing
 * caller keeps type-checking unchanged.
 */
export interface AppMirrorDeps {
  db: Kysely<VetraAppsDB>;
  docs?: AppDocStore | null;
  logger: Pick<Console, "warn">;
}

/**
 * Mirrors a row's *current* facts into its document, creating the document
 * first if it is missing.
 *
 * Mirroring the whole row rather than the columns that changed is deliberate.
 * CONNECT_REPOSITORY, SET_IDENTITY and SET_PREVIEWS replace their group
 * wholesale, so an action built from a partial patch would null the fields the
 * patch left alone. The row is the truth in this step; re-stating it is
 * idempotent and cannot drift.
 *
 * Creating a missing document here also heals an app that was created while
 * the reactor was unreachable.
 */
export async function mirrorAppRow(
  deps: AppMirrorDeps,
  row: AppRow,
): Promise<void> {
  const docs = deps.docs;
  if (!docs) return;
  let created = false;
  try {
    if (!(await docs.exists(row.id))) {
      await docs.create(row.id);
      created = true;
    }
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] creating the document for app ${row.id} failed: ${String(err)}`,
    );
    return;
  }
  await mirrorAppToDocument(
    { db: deps.db, docs, logger: deps.logger },
    row.id,
    appDocumentActions(row),
  );
  if (created) await protectNewAppDocument(docs, row.id, deps.logger);
}

/** Mirrors an app by id, when the caller has the id but not the row. */
export async function mirrorAppById(
  deps: AppMirrorDeps,
  appId: string,
): Promise<void> {
  try {
    const row = await deps.db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", appId)
      .executeTakeFirst();
    if (!row) return;
    await mirrorAppRow(deps, row);
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] reloading app ${appId} to mirror it failed: ${String(err)}`,
    );
  }
}
