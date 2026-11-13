import { sql, type Kysely } from "kysely";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";

/**
 * Which Harbor project (if any) an App-linked env may pull its FUSION image
 * from. Resolved from the vetra-apps relational tables — never from the
 * document's own `app.imageProject`, which an owner could forge with an
 * unsigned SET_APP_LINK.
 */
export type AppImageProjectResolver = (
  state: VetraCloudEnvironmentState,
  documentId: string,
  /** The caller's warm-pool lookup for this document, when it already did one. */
  warm?: WarmPoolEntry | null,
) => Promise<string | null>;

export type WarmPoolEntry = {
  appId: string;
  /** A switch-over dry-run clone: every ingress closed, backups off. */
  rehearsal?: boolean;
};

/**
 * Whether a document is a live warm-pool environment (pre-started, ownerless,
 * waiting to be claimed), and for which App.
 */
export type WarmPoolLookup = (
  documentId: string,
) => Promise<WarmPoolEntry | null>;

const UNDEFINED_TABLE = "42P01";

/**
 * A missing table (42P01: vetra-apps or vetra-licensing has not created it
 * yet, boot order is not fixed) answers `missing`; any other failure
 * propagates and fails the render. A failed render writes nothing to git, so
 * a running environment keeps its previous values; answering "no project"
 * instead would render its app disabled, which drops its CNPG cluster and
 * with it the database.
 */
async function unlessMissing<T>(
  read: () => Promise<T>,
  missing: T,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE)
      return missing;
    throw err;
  }
}

/**
 * One warm-pool lookup for a render. The warm-pool table missing (42P01: the
 * licensing subgraph has not created it yet, boot order is not fixed) means
 * nothing is warm; any other failure propagates, so a warm environment can
 * never render open by accident.
 */
export async function lookupWarm(
  isWarm: WarmPoolLookup,
  documentId: string,
): Promise<WarmPoolEntry | null> {
  try {
    return await isWarm(documentId);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE)
      return null;
    throw err;
  }
}

/**
 * Whether an environment is held (vetra-apps `environment_holds`): kept with
 * its database, backups and data volumes while its app does not run.
 */
export type HoldLookup = (documentId: string) => Promise<boolean>;

/**
 * One hold lookup for a render. The holds table missing (42P01: vetra-apps
 * has not created it yet) means nothing is held; any other failure
 * propagates, so a held environment never starts by accident.
 */
export async function lookupHeld(
  isHeld: HoldLookup,
  documentId: string,
): Promise<boolean> {
  try {
    return await isHeld(documentId);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE)
      return false;
    throw err;
  }
}

/**
 * The App named by `state.app.appId` must exist, and this document must be
 * its production env or one of its preview envs. Missing tables (vetra-apps
 * not migrated yet) → null (no App project); any other failure propagates.
 */
export function createAppImageProjectResolver(
  appsDb: Kysely<any>,
  licensingDb: Kysely<any> | null = null,
  isWarm: WarmPoolLookup | null = null,
): AppImageProjectResolver {
  return async (state, documentId, warm) => {
    const appId = state.app?.appId;
    if (!appId)
      return licensedImageProject(
        appsDb,
        licensingDb,
        documentId,
        isWarm,
        warm,
        state.fusion?.image ?? null,
      );
    return unlessMissing(async () => {
      const app = (await appsDb
        .selectFrom("apps")
        .select([
          "harbor_project",
          "production_environment_id",
          "registry_namespace",
        ])
        .where("id", "=", appId)
        .executeTakeFirst()) as
        | {
            harbor_project: string;
            production_environment_id: string;
            registry_namespace: string | null;
          }
        | undefined;
      if (!app) return null;
      if (app.production_environment_id === documentId)
        return app.harbor_project;
      const preview = await appsDb
        .selectFrom("app_previews")
        .select("environment_id")
        .where("app_id", "=", appId)
        .where("environment_id", "=", documentId)
        .executeTakeFirst();
      if (preview) return app.harbor_project;
      // A releases-phase-2 instance runs the App's images from its registry
      // namespace (cr.vetra.io/<namespace>/<slug>), vouched for by the
      // instances table, never by the document.
      const instance = await appsDb
        .selectFrom("instances")
        .select("id")
        .where("app_id", "=", appId)
        .where("environment_id", "=", documentId)
        .executeTakeFirst();
      return instance ? app.registry_namespace : null;
    }, null);
  };
}

/** Whether the App recorded a release or build whose image is in `repository` (no tag). */
async function releasedFrom(
  appsDb: Kysely<any>,
  appId: string,
  repository: string,
): Promise<boolean> {
  // No releases table yet: the App's Harbor project only.
  return unlessMissing(async () => {
    const row = await appsDb
      .selectFrom("releases")
      .select("version")
      .where("app_id", "=", appId)
      .where(sql<boolean>`starts_with(image_ref, ${`${repository}:`})`)
      .executeTakeFirst();
    return row !== undefined;
  }, false);
}

/**
 * An environment Vetra provisioned for a licence (a holder's dedicated env,
 * e.g. a Sektar cloud host) runs its licence's App's image: the
 * `license_environments` row (vetra-licensing tables, written by provisioning,
 * never by the document) names the App, whose Harbor project or own released
 * repository it may pull from (the document's image only picks which of the
 * two is answered). Missing tables → null; any other failure propagates.
 */
async function licensedImageProject(
  appsDb: Kysely<any>,
  licensingDb: Kysely<any> | null,
  documentId: string,
  isWarm: WarmPoolLookup | null,
  given: WarmPoolEntry | null | undefined,
  /** The document's FUSION image: which of the App's two projects to vouch for. */
  image: string | null,
): Promise<string | null> {
  return unlessMissing(async () => {
    // A warm environment has no license_environments row yet (the claim writes
    // it); the warm pool names its App. A render hands in its own lookup.
    const warm =
      given !== undefined
        ? given
        : isWarm
          ? await lookupWarm(isWarm, documentId)
          : null;
    let appId = warm?.appId;
    if (!appId) {
      if (!licensingDb) return null;
      const licensed = (await licensingDb
        .selectFrom("license_environments")
        .select("app_id")
        .where("environment_id", "=", documentId)
        .executeTakeFirst()) as { app_id: string } | undefined;
      if (!licensed) return null;
      appId = licensed.app_id;
    }
    const app = (await appsDb
      .selectFrom("apps")
      .select("harbor_project")
      .where("id", "=", appId)
      .executeTakeFirst()) as { harbor_project: string | null } | undefined;
    if (!app) return null;
    // The App's releases (vetra-publish) live in its registry namespace: the
    // ci/releases bridge points licensed environments there. Only this App's
    // own repository is vouched for, proven by a release it recorded
    // (ci/releases checked image.ref is cr.vetra.io/<namespace>/<slug>), never
    // the rest of the owner's namespace. A release keeps its repository when
    // the App is renamed or changes hands. Older images stay in the App's
    // own Harbor project.
    if (image && (await releasedFrom(appsDb, appId, image))) {
      return image.split("/")[1] ?? null;
    }
    return app.harbor_project ?? null;
  }, null);
}
