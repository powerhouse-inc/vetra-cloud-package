import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { hasPublisherCapability, type MembershipReader } from "../../shared/org-access.js";
import type { OrgMembership } from "../../shared/renown-orgs.js";
import { withEnvLock } from "../../shared/key-lock.js";
import { parseOperators, unresolvedAppDid } from "./env-access.js";
import {
  GRANTED_BY,
  lastComputedOperators,
  protectEnvironment,
  recordComputedOperators,
  RESTRICTION_GRANTEE,
  type EnvProtectionOptions,
  type EnvProtectionResult,
  type EnvProtectionService,
} from "./env-protection.js";

export {
  GRANTED_BY,
  ORG_SYSTEM_OPERATIONS,
  RESTRICTION_GRANTEE,
  restrictSystemOperations,
  SYSTEM_ONLY_OPERATIONS,
  type OperationRestrictions,
} from "./env-protection.js";

/** The slice of reactor-api's DocumentPermissionService the sync uses. */
export type DocumentGrants = EnvProtectionService;

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
  /** Protection owner of organisation envs (the Vetra service identity); default: nobody. */
  serviceOwner?: string;
  /** Per-process memo of operation restrictions already applied. */
  restricted?: Set<string>;
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
 * In-process lock per environment (shared/key-lock.ts): the job and on-demand
 * syncs of one env run one after the other, so a full-list SYNC_ORG_OPERATORS
 * never overwrites an operator another sync just added. vetra-apps' ownership
 * moves take the same lock.
 */
export { withEnvLock };

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
  // Before any grant: the document belongs to the service identity, not the
  // creator (no ADMIN left that could submit unsigned "system" actions), and
  // the organisation move was one Vetra made (else it was just reverted).
  const protection = await protectOrgEnv(deps, { id: env.id, owner: state.owner, ownerOrgId: orgId });
  if (protection === "REVERTED") return { result: "SKIPPED", operators: [] };
  if (protection === "SKIPPED" || protection === "PERSONAL" || protection === "UNOWNED") {
    return { result: "SKIPPED", operators: current };
  }
  // The list the sync last computed: a document list that differs was set by
  // someone else (SYNC_ORG_OPERATORS from outside) and is not trusted as a
  // source of candidates; it is recomputed from Renown.
  const last = await lastComputedOperators(deps.db, env.id);
  const base = last && !sameSet(current, last) ? lower(last) : current;
  if (base !== current) deps.logger?.warn(`[org-sync] ${env.id}: operators changed outside the sync; recomputing`);
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
  const pool = [...new Set([...(owner ? [owner] : []), ...base, ...writeHolders, ...lower(candidates)])];
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
  // Recorded before the dispatch, so its change event is recognised as ours.
  await recordComputedOperators(deps.db, env.id, next);
  if (changed) await deps.dispatch(env.id, "SYNC_ORG_OPERATORS", { operators: next });
  await reconcileWriteGrants(deps, env.id, next, (a) => memberships.get(a) ?? null);
  return { result: changed ? "UPDATED" : "UNCHANGED", operators: next };
}

/** The protection options the sync uses (document reads, revert dispatch). */
export function orgProtectionOptions(deps: OrgSyncDeps): EnvProtectionOptions {
  const hasReader = !!deps.readOrgState;
  return {
    serviceOwner: deps.serviceOwner ?? RESTRICTION_GRANTEE,
    db: deps.db,
    restricted: deps.restricted,
    readTarget: hasReader
      ? async (id) => {
          const s = await deps.readOrgState?.(id);
          return s ? { id, owner: s.owner, ownerOrgId: s.ownerOrgId, orgOperators: s.orgOperators } : null;
        }
      : undefined,
    dispatch: (documentId, type, input) => deps.dispatch(documentId, type, input),
    logger: deps.logger,
  };
}

/** Organisation env protection (service-owned, system operations restricted); null without a permission service. */
async function protectOrgEnv(
  deps: OrgSyncDeps,
  env: { id: string; owner: string | null; ownerOrgId: string },
): Promise<EnvProtectionResult | null> {
  if (!deps.perm) return null;
  return protectEnvironment(deps.perm, env, orgProtectionOptions(deps));
}

/**
 * Change-event check: an org env whose document operators differ from the
 * list the sync last computed was changed from outside; resync it from Renown.
 */
export async function resyncIfTampered(
  deps: OrgSyncDeps,
  target: { id: string; ownerOrgId: string | null; orgOperators?: string[] },
): Promise<boolean> {
  if (!target.ownerOrgId || !target.orgOperators) return false;
  const last = await lastComputedOperators(deps.db, target.id);
  if (!last || sameSet(last, target.orgOperators)) return false;
  const row = (await deps.envDb
    .selectFrom("environments")
    .select(["id", "owner", "ownerOrgId", "orgOperators", "appId"])
    .where("id", "=", target.id)
    .executeTakeFirst()) as OrgEnvRow | undefined;
  await syncEnvironmentOrgOnce(deps, row ?? { id: target.id, owner: null, ownerOrgId: target.ownerOrgId, orgOperators: null, appId: null });
  return true;
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
 * Grants Vetra did not create are never touched. The creator is treated like
 * any member: their protection ADMIN is gone once the env is org-owned.
 */
async function reconcileWriteGrants(
  deps: OrgSyncDeps,
  envId: string,
  operators: string[],
  membershipOf: (address: string) => OrgMembership | null,
): Promise<void> {
  const d = withPerm(deps);
  if (!d) return;
  for (const address of operators) await setOwnedGrant(d, envId, address, "WRITE");
  const rows = await d.db
    .selectFrom("org_document_grants")
    .select(["address", "level"])
    .where("documentId", "=", envId)
    .where("level", "=", "WRITE")
    .execute();
  for (const r of rows) {
    if (operators.includes(r.address)) continue;
    if (membershipOf(r.address)) await setOwnedGrant(d, envId, r.address, "READ");
    else await dropOwnedGrant(d, envId, r.address);
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
  const orgId = env.ownerOrgId;
  if (!d || !orgId) return;
  await withEnvLock(env.id, async () => {
    if ((await protectOrgEnv(deps, { id: env.id, owner: env.owner, ownerOrgId: orgId })) !== "ORG") return;
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
    await dropOwnedGrant(d, env.id, address);
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
