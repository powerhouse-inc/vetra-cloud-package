import { type Kysely } from "kysely";
import type { VetraGithubAuthDB } from "./schema.js";

export type GithubConnection = {
  userDid: string;
  environmentId: string;
  repoFullName: string;
  createdAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toConnection(row: {
  user_did: string;
  environment_id: string;
  repo_full_name: string;
  created_at: string;
}): GithubConnection {
  return {
    userDid: row.user_did,
    environmentId: row.environment_id,
    repoFullName: row.repo_full_name,
    createdAt: row.created_at,
  };
}

/**
 * The caller's GitHub connection for one environment, or null if they have not
 * connected that environment. Keyed on (DID, environment) so a caller only ever
 * sees their own environments' connections.
 */
export async function getConnection(
  db: Kysely<VetraGithubAuthDB>,
  did: string,
  environmentId: string,
): Promise<GithubConnection | null> {
  const row = await db
    .selectFrom("github_installations")
    .selectAll()
    .where("user_did", "=", did)
    .where("environment_id", "=", environmentId)
    .executeTakeFirst();
  return row ? toConnection(row) : null;
}

/**
 * Save (or replace) a connection for a (DID, environment). One row per
 * environment: re-connecting the same environment replaces its installation/repo,
 * and a user can hold a separate repo for each environment they own.
 */
export async function saveConnection(
  db: Kysely<VetraGithubAuthDB>,
  did: string,
  environmentId: string,
  repoFullName: string,
): Promise<GithubConnection> {
  const createdAt = nowIso();
  await db
    .insertInto("github_installations")
    .values({
      user_did: did,
      environment_id: environmentId,
      repo_full_name: repoFullName,
      created_at: createdAt,
    })
    .onConflict((oc) =>
      oc.columns(["user_did", "environment_id"]).doUpdateSet({
        repo_full_name: repoFullName,
        created_at: createdAt,
      }),
    )
    .execute();
  return { userDid: did, environmentId, repoFullName, createdAt };
}

/**
 * Remove a (DID, environment) connection (e.g. after detecting the app was
 * uninstalled).
 */
export async function deleteConnection(
  db: Kysely<VetraGithubAuthDB>,
  did: string,
  environmentId: string,
): Promise<void> {
  await db
    .deleteFrom("github_installations")
    .where("user_did", "=", did)
    .where("environment_id", "=", environmentId)
    .execute();
}
