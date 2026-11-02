import type { Kysely } from "kysely";
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
) => Promise<string | null>;

/**
 * Whether a document is a live warm-pool environment (pre-started, ownerless,
 * waiting to be claimed), and for which App.
 */
export type WarmPoolLookup = (
  documentId: string,
) => Promise<{ appId: string } | null>;

/**
 * The App named by `state.app.appId` must exist, and this document must be
 * its production env or one of its preview envs. Missing tables (vetra-apps
 * not migrated yet) or any query failure → null (no App project).
 */
export function createAppImageProjectResolver(
  appsDb: Kysely<any>,
  licensingDb: Kysely<any> | null = null,
  isWarm: WarmPoolLookup | null = null,
): AppImageProjectResolver {
  return async (state, documentId) => {
    const appId = state.app?.appId;
    if (!appId) return licensedImageProject(appsDb, licensingDb, documentId, isWarm);
    try {
      const app = (await appsDb
        .selectFrom("apps")
        .select(["harbor_project", "production_environment_id"])
        .where("id", "=", appId)
        .executeTakeFirst()) as
        | { harbor_project: string; production_environment_id: string }
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
      return preview ? app.harbor_project : null;
    } catch {
      return null;
    }
  };
}

/**
 * An environment Vetra provisioned for a licence (a holder's dedicated env,
 * e.g. a Sektar cloud host) runs its licence's App's image: the
 * `license_environments` row (vetra-licensing tables, written by provisioning,
 * never by the document) names the App. Missing tables or any failure → null.
 */
async function licensedImageProject(
  appsDb: Kysely<any>,
  licensingDb: Kysely<any> | null,
  documentId: string,
  isWarm: WarmPoolLookup | null,
): Promise<string | null> {
  try {
    // A warm environment has no license_environments row yet (the claim writes
    // it); the warm pool names its App.
    const warm = isWarm ? await isWarm(documentId) : null;
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
    return app?.harbor_project ?? null;
  } catch {
    return null;
  }
}
