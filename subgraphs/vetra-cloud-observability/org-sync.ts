import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { hasPublisherCapability, type MembershipReader } from "../../shared/org-access.js";
import type { OrgMembership } from "../../shared/renown-orgs.js";
import { parseOperators, unresolvedAppDid } from "./env-access.js";

/** The slice of reactor-api's DocumentPermissionService the sync uses. */
export interface DocumentGrants {
  grantPermission(
    documentId: string,
    userAddress: string,
    permission: "READ" | "WRITE" | "ADMIN",
    grantedBy: string,
  ): Promise<unknown>;
  revokePermission(documentId: string, userAddress: string): Promise<void>;
}

export interface OrgSyncDeps {
  envDb: Kysely<any>;
  db: Kysely<ObservabilityDB>;
  orgs: MembershipReader;
  appDidOf(appId: string): Promise<string | null>;
  dispatch(documentId: string, type: string, input: Record<string, unknown>): Promise<void>;
  perm: DocumentGrants | null;
  logger?: Pick<Console, "info" | "warn">;
}

export interface OrgEnvRow {
  id: string;
  owner: string | null;
  ownerOrgId: string | null;
  orgOperators: string | null;
  appId: string | null;
}

export type OrgSyncResult = { result: "UPDATED" | "UNCHANGED" | "SKIPPED"; operators: string[] };

const GRANTED_BY = "vetra-org-sync";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Recompute the operators of one org env from Renown: the creator, every
 * current operator and every candidate are checked; those with publisher
 * capability (for the env's app, if any) stay. Any Renown or app-lookup
 * failure → SKIPPED: the document and the grants are left as they are, so an
 * outage never shrinks the operator list.
 */
export async function syncEnvironmentOrgOnce(
  deps: OrgSyncDeps,
  env: OrgEnvRow,
  candidates: string[] = [],
): Promise<OrgSyncResult> {
  const current = parseOperators(env.orgOperators);
  const orgId = env.ownerOrgId;
  if (!orgId) return { result: "SKIPPED", operators: current };
  let appDid: string | null = null;
  if (env.appId) {
    try {
      // Same rule as env-access: a link that does not resolve matches no scope.
      appDid = (await deps.appDidOf(env.appId)) ?? unresolvedAppDid(env.appId);
    } catch {
      return { result: "SKIPPED", operators: current };
    }
  }
  const owner = env.owner?.toLowerCase() ?? null;
  // Holders of a WRITE grant Vetra made are re-checked too, so a grant is
  // only ever revoked on a known answer from Renown.
  const writeHolders = deps.perm
    ? (
        await deps.db
          .selectFrom("org_document_grants")
          .select("address")
          .where("documentId", "=", env.id)
          .where("level", "=", "WRITE")
          .execute()
      ).map((r) => r.address)
    : [];
  const pool = [
    ...new Set([
      ...(owner ? [owner] : []),
      ...current.map((c) => c.toLowerCase()),
      ...writeHolders,
      ...candidates.map((c) => c.toLowerCase()),
    ]),
  ];
  const memberships = new Map<string, OrgMembership | null>();
  for (const address of pool) {
    try {
      memberships.set(address, await deps.orgs.membership(orgId, address));
    } catch {
      return { result: "SKIPPED", operators: current };
    }
  }
  const next = pool.filter((a) => hasPublisherCapability(memberships.get(a) ?? null, appDid));
  const changed = !sameSet(current, next);
  if (changed) await deps.dispatch(env.id, "SYNC_ORG_OPERATORS", { operators: next });
  await reconcileWriteGrants(deps, env.id, owner, next, (a) => memberships.get(a) ?? null);
  return { result: changed ? "UPDATED" : "UNCHANGED", operators: next };
}

/**
 * WRITE for every operator; a WRITE grant Vetra made for someone who no longer
 * operates is revoked, or lowered to READ when they are still a member.
 * Grants Vetra did not record are never touched, nor is the owner's own grant.
 */
async function reconcileWriteGrants(
  deps: OrgSyncDeps,
  envId: string,
  owner: string | null,
  operators: string[],
  membershipOf: (address: string) => OrgMembership | null,
): Promise<void> {
  if (!deps.perm) return;
  const rows = await deps.db.selectFrom("org_document_grants").selectAll().where("documentId", "=", envId).execute();
  const have = new Map(rows.map((r) => [r.address, r.level]));
  for (const address of operators) {
    // The owner's protection grant is ADMIN; granting WRITE would downgrade it.
    if (address === owner || have.get(address) === "WRITE") continue;
    await deps.perm.grantPermission(envId, address, "WRITE", GRANTED_BY);
    await recordGrant(deps, envId, address, "WRITE");
  }
  for (const r of rows) {
    if (r.level !== "WRITE" || operators.includes(r.address)) continue;
    if (r.address !== owner && membershipOf(r.address)) {
      await deps.perm.grantPermission(envId, r.address, "READ", GRANTED_BY);
      await recordGrant(deps, envId, r.address, "READ");
      continue;
    }
    if (r.address !== owner) await deps.perm.revokePermission(envId, r.address);
    await deleteGrant(deps, envId, r.address);
  }
}

async function recordGrant(deps: OrgSyncDeps, documentId: string, address: string, level: "READ" | "WRITE") {
  const grantedAt = new Date().toISOString();
  await deps.db
    .insertInto("org_document_grants")
    .values({ documentId, address, level, grantedAt })
    .onConflict((oc) => oc.columns(["documentId", "address"]).doUpdateSet({ level, grantedAt }))
    .execute();
}

async function deleteGrant(deps: OrgSyncDeps, documentId: string, address: string) {
  await deps.db
    .deleteFrom("org_document_grants")
    .where("documentId", "=", documentId)
    .where("address", "=", address)
    .execute();
}

/** READ for a member who views (but does not operate) an org env. */
export async function grantViewer(deps: OrgSyncDeps, env: OrgEnvRow, address: string): Promise<void> {
  const addr = address.toLowerCase();
  if (!deps.perm || !env.ownerOrgId || addr === env.owner?.toLowerCase()) return;
  const existing = await deps.db
    .selectFrom("org_document_grants")
    .select("level")
    .where("documentId", "=", env.id)
    .where("address", "=", addr)
    .executeTakeFirst();
  if (existing) return;
  await deps.perm.grantPermission(env.id, addr, "READ", GRANTED_BY);
  await recordGrant(deps, env.id, addr, "READ");
}

/** Revoke READ grants of members who left; a Renown failure keeps the grant. */
async function revalidateViewers(deps: OrgSyncDeps, env: OrgEnvRow): Promise<void> {
  if (!deps.perm || !env.ownerOrgId) return;
  const viewers = await deps.db
    .selectFrom("org_document_grants")
    .select("address")
    .where("documentId", "=", env.id)
    .where("level", "=", "READ")
    .execute();
  for (const { address } of viewers) {
    let member: OrgMembership | null;
    try {
      member = await deps.orgs.membership(env.ownerOrgId, address);
    } catch {
      continue;
    }
    if (member) continue;
    if (address !== env.owner?.toLowerCase()) await deps.perm.revokePermission(env.id, address);
    await deleteGrant(deps, env.id, address);
  }
}

/** The 5-minute job: every org env. Returns how many it visited. */
export async function runOrgSyncOnce(deps: OrgSyncDeps): Promise<number> {
  const envs = (await deps.envDb
    .selectFrom("environments")
    .select(["id", "owner", "ownerOrgId", "orgOperators", "appId"])
    .where("ownerOrgId", "is not", null)
    .orderBy("id")
    .execute()) as OrgEnvRow[];
  for (const env of envs) {
    try {
      await syncEnvironmentOrgOnce(deps, env);
      await revalidateViewers(deps, env);
    } catch (err) {
      deps.logger?.warn(`[org-sync] ${env.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return envs.length;
}
