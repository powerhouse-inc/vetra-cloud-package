import { type Kysely } from "kysely";
import type { VetraGithubAuthDB } from "./schema.js";

export type GithubIdentity = {
  userDid: string;
  githubLogin: string;
  githubUserId: string;
  createdAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

/** The caller's DID ↔ GitHub identity link, or null if they never authorized. */
export async function getIdentity(
  db: Kysely<VetraGithubAuthDB>,
  did: string,
): Promise<GithubIdentity | null> {
  const row = await db
    .selectFrom("github_identities")
    .selectAll()
    .where("user_did", "=", did)
    .executeTakeFirst();
  return row
    ? {
        userDid: row.user_did,
        githubLogin: row.github_login,
        githubUserId: row.github_user_id,
        createdAt: row.created_at,
      }
    : null;
}

/**
 * Save (or refresh) the DID → GitHub identity link. Upserts on DID so a login
 * rename or account switch on re-authorization replaces the old link.
 */
export async function saveIdentity(
  db: Kysely<VetraGithubAuthDB>,
  did: string,
  githubLogin: string,
  githubUserId: string,
): Promise<GithubIdentity> {
  const createdAt = nowIso();
  await db
    .insertInto("github_identities")
    .values({
      user_did: did,
      github_login: githubLogin,
      github_user_id: githubUserId,
      created_at: createdAt,
    })
    .onConflict((oc) =>
      oc.columns(["user_did"]).doUpdateSet({
        github_login: githubLogin,
        github_user_id: githubUserId,
        created_at: createdAt,
      }),
    )
    .execute();
  return { userDid: did, githubLogin, githubUserId, createdAt };
}
