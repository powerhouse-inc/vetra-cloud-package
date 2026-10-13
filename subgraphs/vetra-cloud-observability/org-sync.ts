import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { hasPublisherCapability, type MembershipReader } from "../../shared/org-access.js";
import type { OrgMembership } from "../../shared/renown-orgs.js";
import { parseOperators, unresolvedAppDid } from "./env-access.js";

const GRANTED_BY = "vetra-org-sync";

/** reactor-api operation-level permissions (DocumentPermissionService). */
export interface OperationRestrictions {
  isOperationRestricted(documentId: string, operationType: string): Promise<boolean>;
  grantOperationPermission(
    documentId: string,
    operationType: string,
    userAddress: string,
    grantedBy: string,
  ): Promise<unknown>;
}

/**
 * Operations whose reducers trust any action without a user signer as
 * "system". reactor-api accepts unsigned (or user-less signed) actions from
 * any caller with WRITE, so on a document Vetra grants WRITE on these are
 * restricted at reactor-api: only platform admins and the document's
 * protection owner / ADMIN grantees may submit them from outside. In-process
 * dispatches (reactorClient) are not affected.
 */
export const SYSTEM_ONLY_OPERATIONS = [
  "SET_OWNER",
  "SET_OWNER_ORG",
  "SYNC_ORG_OPERATORS",
  "SET_APP_LINK",
  "CLEAR_APP_LINK",
] as const;

/** Grantee that marks an operation restricted; nobody can sign in as it. */
export const RESTRICTION_GRANTEE = "0x0000000000000000000000000000000000000000";

/** Restrict SYSTEM_ONLY_OPERATIONS on a document (idempotent). */
export async function restrictSystemOperations(perm: OperationRestrictions, documentId: string): Promise<void> {
  for (const op of SYSTEM_ONLY_OPERATIONS) {
    if (await perm.isOperationRestricted(documentId, op)) continue;
    await perm.grantOperationPermission(documentId, op, RESTRICTION_GRANTEE, GRANTED_BY);
  }
}

/** The slice of reactor-api's DocumentPermissionService the sync uses. */
export interface DocumentGrants extends OperationRestrictions {
  /** The address's current permission on the document (any origin), or null. */
  getUserPermission(documentId: string, userAddress: string): Promise<string | null>;
  grantPermission(
    documentId: string,
    userAddress: string,
    permission: "READ" | "WRITE" | "ADMIN",
    grantedBy: string,
  ): Promise<unknown>;
  revokePermission(documentId: string, userAddress: string): Promise<void>;
}

/** The organisation fields of the environment document itself (not the read model). */
export interface OrgDocState {
  owner: string | null;
  ownerOrgId: string | null;
  orgOperators: string[];
}

export interface OrgSyncDeps {
  envDb: Kysely<any>;
  db: Kysely<ObservabilityDB>;
  orgs: MembershipReader;
  appDidOf(appId: string): Promise<string | null>;
  dispatch(documentId: string, type: string, input: Record<string, unknown>): Promise<void>;
  perm: DocumentGrants | null;
  /**
   * Reads the environment document's current organisation state. The read
   * model lags behind dispatches, so the sync bases the next operator list on
   * this when available; null means the document is gone. Without it the
   * read-model row is re-read inside the per-env lock.
   */
  readOrgState?(documentId: string): Promise<OrgDocState | null>;
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

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
const sameSet = (a: string[], b: string[]) => {
  const la = lower(a);
  const lb = lower(b);
  return la.length === lb.length && la.every((x) => lb.includes(x));
};

/**
 * In-process lock per environment: the job and on-demand syncs of one env run
 * one after the other, so a full-list SYNC_ORG_OPERATORS never overwrites an
 * operator another sync just added.
 */
const envLocks = new Map<string, Promise<unknown>>();
async function withEnvLock<T>(envId: string, fn: () => Promise<T>): Promise<T> {
  const prev = envLocks.get(envId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  envLocks.set(envId, tail);
  try {
    return await run;
  } finally {
    if (envLocks.get(envId) === tail) envLocks.delete(envId);
  }
}

/**
 * Recompute the operators of one org env from Renown: the creator, every
 * current operator, every holder of a Vetra WRITE grant and every candidate
 * are checked; those with publisher capability (for the env's app, if any)
 * stay. Any Renown, app-lookup or document-read failure → SKIPPED: the
 * document and the grants are left as they are, so an outage never shrinks
 * the operator list.
 */
export async function syncEnvironmentOrgOnce(
  deps: OrgSyncDeps,
  env: OrgEnvRow,
  candidates: string[] = [],
): Promise<OrgSyncResult> {
  return withEnvLock(env.id, () => syncUnlocked(deps, env, candidates));
}

/** The env's organisation state, freshest source first; null → skip. */
async function currentOrgState(deps: OrgSyncDeps, env: OrgEnvRow): Promise<OrgDocState | null> {
  if (deps.readOrgState) {
    try {
      return await deps.readOrgState(env.id);
    } catch {
      return null;
    }
  }
  const row = (await deps.envDb
    .selectFrom("environments")
    .select(["orgOperators"])
    .where("id", "=", env.id)
    .executeTakeFirst()) as { orgOperators: string | null } | undefined;
  return {
    owner: env.owner,
    ownerOrgId: env.ownerOrgId,
    orgOperators: parseOperators(row ? row.orgOperators : env.orgOperators),
  };
}

async function syncUnlocked(deps: OrgSyncDeps, env: OrgEnvRow, candidates: string[]): Promise<OrgSyncResult> {
  const state = await currentOrgState(deps, env);
  if (!state) return { result: "SKIPPED", operators: parseOperators(env.orgOperators) };
  const current = lower(state.orgOperators);
  const orgId = state.ownerOrgId;
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
  const owner = state.owner?.toLowerCase() ?? null;
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
  const pool = [...new Set([...(owner ? [owner] : []), ...current, ...writeHolders, ...lower(candidates)])];
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
 * Vetra's record of an address's grant, only while it still owns the actual
 * permission: when the permission was changed by someone else (another level)
 * the record is dropped and the permission is left alone from then on.
 */
async function ownedGrant(
  deps: OrgSyncDeps & { perm: DocumentGrants },
  documentId: string,
  address: string,
): Promise<{ recorded: string | null; actual: string | null; foreign: boolean }> {
  const row = await deps.db
    .selectFrom("org_document_grants")
    .select("level")
    .where("documentId", "=", documentId)
    .where("address", "=", address)
    .executeTakeFirst();
  const actual = await deps.perm.getUserPermission(documentId, address);
  if (row) {
    if (actual === null || actual === row.level) return { recorded: row.level, actual, foreign: false };
    await deleteGrant(deps, documentId, address);
    return { recorded: null, actual, foreign: true };
  }
  return { recorded: null, actual, foreign: actual !== null };
}

/**
 * Set a Vetra-owned grant. A permission Vetra did not create is never touched
 * (no upgrade, no downgrade, no record). The record is written first and
 * removed again if the grant fails, so no grant exists without a record.
 */
async function setOwnedGrant(
  deps: OrgSyncDeps & { perm: DocumentGrants },
  documentId: string,
  address: string,
  level: "READ" | "WRITE",
): Promise<void> {
  const { recorded, actual, foreign } = await ownedGrant(deps, documentId, address);
  if (foreign || (recorded === level && actual === level)) return;
  await recordGrant(deps, documentId, address, level);
  try {
    await deps.perm.grantPermission(documentId, address, level, GRANTED_BY);
  } catch (err) {
    if (recorded) await recordGrant(deps, documentId, address, recorded as "READ" | "WRITE");
    else await deleteGrant(deps, documentId, address);
    throw err;
  }
}

/** Remove a Vetra-owned grant; one changed by someone else is only forgotten. */
async function dropOwnedGrant(
  deps: OrgSyncDeps & { perm: DocumentGrants },
  documentId: string,
  address: string,
): Promise<void> {
  const { recorded, actual } = await ownedGrant(deps, documentId, address);
  if (!recorded) return;
  if (actual !== null) await deps.perm.revokePermission(documentId, address);
  await deleteGrant(deps, documentId, address);
}

const withPerm = (deps: OrgSyncDeps): (OrgSyncDeps & { perm: DocumentGrants }) | null =>
  deps.perm ? { ...deps, perm: deps.perm } : null;

/**
 * WRITE for every operator; a WRITE grant Vetra made for someone who no longer
 * operates is revoked, or lowered to READ when they are still a member.
 * Grants Vetra did not create are never touched, nor is the owner's grant.
 */
async function reconcileWriteGrants(
  deps: OrgSyncDeps,
  envId: string,
  owner: string | null,
  operators: string[],
  membershipOf: (address: string) => OrgMembership | null,
): Promise<void> {
  const d = withPerm(deps);
  if (!d) return;
  // WRITE lets a caller submit actions directly; close the unsigned
  // "system" path first.
  if (operators.some((a) => a !== owner)) await restrictSystemOperations(d.perm, envId);
  for (const address of operators) {
    // The owner's protection grant is ADMIN; never touch it.
    if (address === owner) continue;
    await setOwnedGrant(d, envId, address, "WRITE");
  }
  const rows = await d.db
    .selectFrom("org_document_grants")
    .select(["address", "level"])
    .where("documentId", "=", envId)
    .where("level", "=", "WRITE")
    .execute();
  for (const r of rows) {
    if (operators.includes(r.address)) continue;
    if (r.address === owner) {
      await deleteGrant(d, envId, r.address);
    } else if (membershipOf(r.address)) {
      await setOwnedGrant(d, envId, r.address, "READ");
    } else {
      await dropOwnedGrant(d, envId, r.address);
    }
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
  const d = withPerm(deps);
  const addr = address.toLowerCase();
  if (!d || !env.ownerOrgId || addr === env.owner?.toLowerCase()) return;
  await withEnvLock(env.id, async () => {
    const { recorded, foreign } = await ownedGrant(d, env.id, addr);
    // An existing Vetra grant (READ or WRITE) already covers viewing.
    if (foreign || recorded) return;
    await setOwnedGrant(d, env.id, addr, "READ");
  });
}

/** Revoke READ grants of members who left; a Renown failure keeps the grant. */
async function revalidateViewers(deps: OrgSyncDeps, env: OrgEnvRow): Promise<void> {
  const d = withPerm(deps);
  if (!d || !env.ownerOrgId) return;
  const viewers = await d.db
    .selectFrom("org_document_grants")
    .select("address")
    .where("documentId", "=", env.id)
    .where("level", "=", "READ")
    .execute();
  for (const { address } of viewers) {
    let member: OrgMembership | null;
    try {
      member = await d.orgs.membership(env.ownerOrgId, address);
    } catch {
      continue;
    }
    if (member) continue;
    if (address === env.owner?.toLowerCase()) await deleteGrant(d, env.id, address);
    else await dropOwnedGrant(d, env.id, address);
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
      await withEnvLock(env.id, async () => {
        await syncUnlocked(deps, env, []);
        await revalidateViewers(deps, env);
      });
    } catch (err) {
      deps.logger?.warn(`[org-sync] ${env.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return envs.length;
}
