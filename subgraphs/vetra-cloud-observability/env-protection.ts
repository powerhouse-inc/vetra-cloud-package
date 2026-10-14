import type { Kysely } from "kysely";
import { DocumentChangeType } from "@powerhousedao/reactor";
import { documentModel as envDocumentModel } from "../../document-models/vetra-cloud-environment/v1/index.js";
import type { ObservabilityDB } from "./db/schema.js";

/**
 * reactor-api document protection for environment documents.
 *
 * The environment reducers treat any action without a user signer as
 * "system", and reactor-api accepts such actions from any caller allowed to
 * write. So:
 *  - the operations whose only gate is "system" are restricted at reactor-api
 *    (operation-level grants), leaving them to document admins;
 *  - a personal env is protected for its owner (ADMIN), as before;
 *  - an organisation env is protected for the Vetra service identity: its
 *    protection ownership moves away from the creator and every grant Vetra
 *    did not record (any level, and operation grants on the system-only
 *    operations) is removed, so nobody but platform admins administers it
 *    from outside.
 *    Members reach it only through the WRITE/READ grants the operator sync
 *    manages.
 */

export const GRANTED_BY = "vetra-org-sync";

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

/** The DocumentPermissionService slice this module uses. */
export interface EnvProtectionService extends OperationRestrictions {
  getDocumentProtection(documentId: string): Promise<{ protected: boolean; ownerAddress: string | null }>;
  initializeDocumentProtection(documentId: string, ownerAddress: string, defaultProtection?: boolean): Promise<unknown>;
  setDocumentProtection(documentId: string, isProtected: boolean): Promise<unknown>;
  setDocumentOwner(documentId: string, ownerAddress: string): Promise<unknown>;
  getDocumentPermissions(documentId: string): Promise<Array<{ userAddress: string; permission: string }>>;
  getUserPermission(documentId: string, userAddress: string): Promise<string | null>;
  grantPermission(
    documentId: string,
    userAddress: string,
    permission: "READ" | "WRITE" | "ADMIN",
    grantedBy: string,
  ): Promise<unknown>;
  revokePermission(documentId: string, userAddress: string): Promise<void>;
  getOperationUserPermissions(documentId: string, operationType: string): Promise<Array<{ userAddress: string }>>;
  revokeOperationPermission(documentId: string, operationType: string, userAddress: string): Promise<void>;
}

/** Operations added by the organisation work whose only gate is "system". */
export const ORG_SYSTEM_OPERATIONS = ["SET_OWNER_ORG", "SYNC_ORG_OPERATORS"] as const;

/**
 * Every operation whose reducer trusts an action without a user signer
 * beyond its owner gate. Restricted on owned envs (SET_OWNER stays open on
 * unowned envs: claiming one is how a user takes it).
 */
export const SYSTEM_ONLY_OPERATIONS = [
  "SET_OWNER",
  ...ORG_SYSTEM_OPERATIONS,
  "SET_APP_LINK",
  "CLEAR_APP_LINK",
] as const;

/**
 * Every operation of the environment model. An operation grant on any of
 * them lets its holder submit that operation (unsigned, i.e. as "system")
 * past the document-level checks, so none may survive into an organisation.
 */
export const ENV_OPERATIONS: readonly string[] = [
  ...new Set(
    (envDocumentModel.specifications.at(-1)?.modules ?? []).flatMap((m) => m.operations.map((o) => o.name ?? "")),
  ),
].filter(Boolean);

/** Grantee that marks an operation restricted; nobody can sign in as it. */
export const RESTRICTION_GRANTEE = "0x0000000000000000000000000000000000000000";

/** Restrict the given operations on a document (idempotent; existing restrictions are kept). */
export async function restrictSystemOperations(
  perm: OperationRestrictions,
  documentId: string,
  operations: readonly string[] = SYSTEM_ONLY_OPERATIONS,
): Promise<void> {
  for (const op of operations) {
    if (await perm.isOperationRestricted(documentId, op)) continue;
    await perm.grantOperationPermission(documentId, op, RESTRICTION_GRANTEE, GRANTED_BY);
  }
}

/**
 * The address organisation envs are protected for: VETRA_SERVICE_ADDRESS,
 * else an address nobody can sign in as (no human key owns org envs;
 * in-process dispatches never pass reactor-api checks, platform admins pass
 * them without ownership). Lowercased.
 */
export function vetraServiceAddress(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VETRA_SERVICE_ADDRESS?.trim() || RESTRICTION_GRANTEE).toLowerCase();
}

export interface EnvProtectionTarget {
  id: string;
  owner: string | null;
  ownerOrgId: string | null;
  /** The document's operators, when known (change events, document reads). */
  orgOperators?: string[];
}

export interface EnvProtectionOptions {
  serviceOwner: string;
  /** Hand-over records, expected moves and last computed operators. */
  db: Kysely<ObservabilityDB>;
  /** Per-process memo of restrictions already applied (`${id}|org` / `${id}|all`). */
  restricted?: Set<string>;
  /**
   * Reads the environment document's current state. Used whenever the given
   * target may be stale (an organisation move, a recorded hand-over, a
   * service-owned document); a failed or missing read skips the env — a
   * snapshot is never acted on there.
   */
  readTarget?(documentId: string): Promise<EnvProtectionTarget | null>;
  /** Dispatches a system action (used to revert an unauthorised organisation move). */
  dispatch?(documentId: string, type: string, input: Record<string, unknown>): Promise<void>;
  logger?: Pick<Console, "warn">;
  /** Clock for expected hand-overs (tests). */
  now?(): Date;
}

export type EnvProtectionResult = "UNOWNED" | "PERSONAL" | "ORG" | "REVERTED" | "SKIPPED";

/** How long a hand-over announced by Vetra stays valid. */
export const EXPECTED_HANDOVER_TTL_MS = 10 * 60 * 1000;

/**
 * Announce an organisation move Vetra itself is about to dispatch
 * (SET_OWNER_ORG): `orgId` is the target organisation, null for a move back
 * to a person. Any other move is reverted by protectEnvironment. Must be
 * written before the dispatch.
 */
export async function expectOrgHandover(
  db: Kysely<ObservabilityDB>,
  documentId: string,
  orgId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + EXPECTED_HANDOVER_TTL_MS).toISOString();
  await db.deleteFrom("org_expected_handovers").where("expiresAt", "<", now.toISOString()).execute();
  await db
    .insertInto("org_expected_handovers")
    .values({ documentId, orgId, expiresAt })
    .onConflict((oc) => oc.column("documentId").doUpdateSet({ orgId, expiresAt }))
    .execute();
}

/**
 * Withdraw an announcement whose dispatch failed, so it cannot cover a later
 * unannounced move. Only the announcement for `orgId` is removed.
 */
export async function withdrawOrgHandover(
  db: Kysely<ObservabilityDB>,
  documentId: string,
  orgId: string | null,
): Promise<void> {
  let q = db.deleteFrom("org_expected_handovers").where("documentId", "=", documentId);
  q = orgId === null ? q.where("orgId", "is", null) : q.where("orgId", "=", orgId);
  await q.execute();
}

/** Consumes a matching, unexpired announcement; false when there is none. */
async function takeExpectedHandover(
  db: Kysely<ObservabilityDB>,
  documentId: string,
  orgId: string | null,
  now: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom("org_expected_handovers")
    .select(["orgId", "expiresAt"])
    .where("documentId", "=", documentId)
    .executeTakeFirst();
  if (!row || (row.orgId ?? null) !== orgId || row.expiresAt < now.toISOString()) return false;
  await db.deleteFrom("org_expected_handovers").where("documentId", "=", documentId).execute();
  return true;
}

/** The operator list the sync last computed for an org env, or null. */
export async function lastComputedOperators(db: Kysely<ObservabilityDB>, documentId: string): Promise<string[] | null> {
  const row = await db
    .selectFrom("org_env_operators")
    .select("operators")
    .where("documentId", "=", documentId)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.operators);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Remember the list the sync computed (written before it is dispatched). */
export async function recordComputedOperators(
  db: Kysely<ObservabilityDB>,
  documentId: string,
  operators: string[],
): Promise<void> {
  const value = JSON.stringify(operators);
  const computedAt = new Date().toISOString();
  await db
    .insertInto("org_env_operators")
    .values({ documentId, operators: value, computedAt })
    .onConflict((oc) => oc.column("documentId").doUpdateSet({ operators: value, computedAt }))
    .execute();
}

/**
 * Bring one environment document's reactor-api protection in line with its
 * owner / organisation. Idempotent; safe to run on every change. Callers
 * hold the env lock.
 *
 * Organisation moves are only honoured when Vetra announced them
 * (expectOrgHandover); any other move — e.g. an unsigned SET_OWNER_ORG a
 * personal owner pushed through reactor-api — is reverted with a system
 * SET_OWNER_ORG to the previous state, and protection is not transferred.
 */
export async function protectEnvironment(
  perm: EnvProtectionService,
  target: EnvProtectionTarget,
  opts: EnvProtectionOptions,
): Promise<EnvProtectionResult> {
  await restrictFor(perm, target, opts);
  const db = opts.db;
  const now = opts.now?.() ?? new Date();
  const service = opts.serviceOwner.toLowerCase();
  const rec = await db
    .selectFrom("org_document_protection")
    .select(["orgId"])
    .where("documentId", "=", target.id)
    .executeTakeFirst();
  const current = await perm.getDocumentProtection(target.id);
  const ownerIsService = current.ownerAddress?.toLowerCase() === service;

  // A recorded org env still in the same org, or a personal env never handed
  // over whose protection already names the given owner, can be trusted as
  // given; anything else (an ownership move included: a stale row must never
  // hand the document back to a previous owner) is decided from the document.
  const protectionOwner = current.ownerAddress?.toLowerCase() ?? null;
  const stable = target.ownerOrgId
    ? rec?.orgId === target.ownerOrgId
    : !rec && !ownerIsService && (target.owner?.toLowerCase() ?? null) === protectionOwner;
  let env = target;
  if (!stable) {
    if (opts.readTarget) {
      let fresh: EnvProtectionTarget | null = null;
      try {
        fresh = await opts.readTarget(target.id);
      } catch {
        fresh = null;
      }
      if (!fresh) return "SKIPPED";
      env = fresh;
      await restrictFor(perm, env, opts);
    } else if (rec || ownerIsService) {
      return "SKIPPED";
    }
  }

  if (env.ownerOrgId) {
    if (rec?.orgId !== env.ownerOrgId && !(await takeExpectedHandover(db, env.id, env.ownerOrgId, now))) {
      return revert(env, rec ? { ownerOrgId: rec.orgId, operators: (await lastComputedOperators(db, env.id)) ?? [] } : null, opts);
    }
    await protectForService(perm, env, service, current, rec ? rec.orgId === env.ownerOrgId : false, opts);
    return "ORG";
  }

  if (rec) {
    // Org → person (or unowned): only when Vetra announced it.
    if (!(await takeExpectedHandover(db, env.id, null, now))) {
      return revert(env, { ownerOrgId: rec.orgId, operators: (await lastComputedOperators(db, env.id)) ?? [] }, opts);
    }
  }
  if (!env.owner) {
    if (rec) await forgetOrg(perm, env.id, null, opts);
    await protectUnowned(perm, env.id, service);
    return "UNOWNED";
  }
  const owner = env.owner.toLowerCase();
  const fresh = await perm.getDocumentProtection(env.id);
  const ownerMatches = fresh.ownerAddress?.toLowerCase() === owner;
  if (!ownerMatches) {
    // Ownership moved (a claim, a transfer, org → person, a server-created
    // env getting its owner): the new owner only. Grants Vetra recorded for
    // an organisation are withdrawn by forgetOrg below.
    await protectForOwner(perm, env.id, owner, rec ? opts.db : null);
  } else if (!fresh.protected) {
    await perm.setDocumentProtection(env.id, true);
  }
  if (rec) await forgetOrg(perm, env.id, owner, opts);
  return "PERSONAL";
}

/**
 * An environment nobody owns yet must not be claimable by whoever reaches it
 * first (the reducer auto-claims an unowned env on any user-signed action):
 *  - created by a user (reactor-api recorded them as protection owner):
 *    protected for that creator, who claims it with their first signed
 *    action (vetra.io sets the owner in the creating batch anyway);
 *  - created in-process (warm pool, no human creator) or already the
 *    service's: protected for the Vetra service identity, every other grant
 *    removed and every system-only operation restricted. Only in-process
 *    system actions (the claim's SET_OWNER) reach it.
 * Idempotent; writes only on a change.
 */
async function protectUnowned(perm: EnvProtectionService, documentId: string, service: string): Promise<void> {
  const current = await perm.getDocumentProtection(documentId);
  const owner = current.ownerAddress?.toLowerCase() ?? null;
  if (owner && owner !== service) {
    if (!current.protected) await perm.setDocumentProtection(documentId, true);
    return;
  }
  if (owner === service && current.protected) return;
  await protectUnownedForService(perm, documentId, service);
}

/**
 * Protect a document for the Vetra service identity with no other access:
 * used for warm-pool environments at creation, before anyone can learn
 * their id.
 */
export async function protectUnownedForService(
  perm: EnvProtectionService,
  documentId: string,
  service: string,
): Promise<void> {
  const keep = service.toLowerCase();
  const current = await perm.getDocumentProtection(documentId);
  if (current.ownerAddress?.toLowerCase() !== keep) {
    await perm.initializeDocumentProtection(documentId, keep, true);
    await perm.setDocumentOwner(documentId, keep);
  }
  if (!current.protected) await perm.setDocumentProtection(documentId, true);
  await restrictSystemOperations(perm, documentId, SYSTEM_ONLY_OPERATIONS);
  await purgeUnmanagedAccess(perm, null, documentId, keep);
}

/**
 * Hand a personal document to `owner`: protected, owned by them with an
 * ADMIN grant, every other document grant and every operation grant
 * (except the restriction marker) removed, the system-only operations
 * restricted. With `db`, grants Vetra recorded for an organisation are left
 * for forgetOrg to withdraw.
 */
export async function protectForOwner(
  perm: EnvProtectionService,
  documentId: string,
  ownerAddress: string,
  db: Kysely<ObservabilityDB> | null = null,
): Promise<void> {
  const owner = ownerAddress.toLowerCase();
  // initializeDocumentProtection seeds `protected` only on first insert; the
  // reactor often pre-creates the row unprotected, so set it explicitly.
  await perm.initializeDocumentProtection(documentId, owner, true);
  const current = await perm.getDocumentProtection(documentId);
  if (!current.protected) await perm.setDocumentProtection(documentId, true);
  if (current.ownerAddress?.toLowerCase() !== owner) await perm.setDocumentOwner(documentId, owner);
  await restrictSystemOperations(perm, documentId, SYSTEM_ONLY_OPERATIONS);
  await purgeUnmanagedAccess(perm, db, documentId, owner);
  if ((await perm.getUserPermission(documentId, owner)) !== "ADMIN") {
    await perm.grantPermission(documentId, owner, "ADMIN", owner);
  }
}

async function restrictFor(perm: EnvProtectionService, env: EnvProtectionTarget, opts: EnvProtectionOptions) {
  const owned = !!env.owner || !!env.ownerOrgId;
  const memo = `${env.id}|${owned ? "all" : "org"}`;
  if (opts.restricted?.has(memo)) return;
  await restrictSystemOperations(perm, env.id, owned ? SYSTEM_ONLY_OPERATIONS : ORG_SYSTEM_OPERATIONS);
  opts.restricted?.add(memo);
}

/** Undo an unannounced organisation move: back to `previous` (null: personal). */
async function revert(
  env: EnvProtectionTarget,
  previous: { ownerOrgId: string | null; operators: string[] } | null,
  opts: EnvProtectionOptions,
): Promise<"REVERTED"> {
  const to = previous ?? { ownerOrgId: null, operators: [] };
  opts.logger?.warn(
    `[env-protection] ${env.id}: unauthorised organisation move to ${env.ownerOrgId ?? "a person"}; reverting to ${to.ownerOrgId ?? "personal"}`,
  );
  if (opts.dispatch) {
    await opts.dispatch(env.id, "SET_OWNER_ORG", { ownerOrgId: to.ownerOrgId ?? "", operators: to.operators });
  }
  return "REVERTED";
}

/**
 * Leaving the organisation: forget the hand-over and the computed operators,
 * and withdraw the organisation grants Vetra made (only those still at the
 * level Vetra set; anything changed since belongs to someone else).
 */
async function forgetOrg(perm: EnvProtectionService, documentId: string, owner: string | null, opts: EnvProtectionOptions) {
  const db = opts.db;
  await db.deleteFrom("org_document_protection").where("documentId", "=", documentId).execute();
  await db.deleteFrom("org_env_operators").where("documentId", "=", documentId).execute();
  const grants = await db
    .selectFrom("org_document_grants")
    .select(["address", "level"])
    .where("documentId", "=", documentId)
    .execute();
  for (const g of grants) {
    if (g.address !== owner && (await perm.getUserPermission(documentId, g.address)) === g.level) {
      await perm.revokePermission(documentId, g.address);
    }
    await db
      .deleteFrom("org_document_grants")
      .where("documentId", "=", documentId)
      .where("address", "=", g.address)
      .execute();
  }
}

/**
 * Organisation env: protected, owned by the Vetra service identity, no ADMIN
 * grants left (the creator's and any previous owner's). Done once per
 * hand-over; `recorded` skips a hand-over already done for this org.
 */
async function protectForService(
  perm: EnvProtectionService,
  env: EnvProtectionTarget,
  service: string,
  current: { protected: boolean; ownerAddress: string | null },
  recorded: boolean,
  opts: EnvProtectionOptions,
): Promise<void> {
  const ownerIsService = current.ownerAddress?.toLowerCase() === service;
  if (current.protected && ownerIsService && recorded) return;
  // setDocumentOwner, not initializeDocumentProtection: the service needs no
  // ADMIN grant, being the protection owner is enough.
  if (!ownerIsService) await perm.setDocumentOwner(env.id, service);
  if (!current.protected) await perm.setDocumentProtection(env.id, true);
  await purgeUnmanagedAccess(perm, opts.db, env.id, service);
  const now = new Date().toISOString();
  const previousOwner = ownerIsService ? null : (current.ownerAddress?.toLowerCase() ?? null);
  await opts.db
    .insertInto("org_document_protection")
    .values({ documentId: env.id, orgId: env.ownerOrgId, previousOwner, transferredAt: now })
    .onConflict((oc) => oc.column("documentId").doUpdateSet({ orgId: env.ownerOrgId, transferredAt: now }))
    .execute();
}

/**
 * Organisation env: every access path to the document that Vetra does not
 * manage is removed — any document grant (READ/WRITE/ADMIN) that
 * org_document_grants does not record at that level (the creator's, ones the
 * creator shared while administering it, ones added later by hand), and every
 * operation grant on the system-only operations except the restriction
 * marker. Only the protection owner (the service identity) is kept. Run at
 * the hand-over and on every operator sync, so nothing granted under the
 * creator's administration survives into the organisation.
 */
export async function purgeUnmanagedAccess(
  perm: EnvProtectionService,
  db: Kysely<ObservabilityDB> | null,
  documentId: string,
  service: string,
): Promise<void> {
  const keep = service.toLowerCase();
  // Without a db nothing is recorded: every grant but `keep`'s goes.
  const recorded = new Map(
    db
      ? (
          await db
            .selectFrom("org_document_grants")
            .select(["address", "level"])
            .where("documentId", "=", documentId)
            .execute()
        ).map((r) => [r.address.toLowerCase(), r.level])
      : [],
  );
  for (const g of await perm.getDocumentPermissions(documentId)) {
    const address = g.userAddress.toLowerCase();
    if (address === keep) continue;
    const level = recorded.get(address);
    if (level === g.permission) continue;
    await perm.revokePermission(documentId, g.userAddress);
    if (level !== undefined && db) {
      await db
        .deleteFrom("org_document_grants")
        .where("documentId", "=", documentId)
        .where("address", "=", address)
        .execute();
    }
  }
  for (const op of new Set([...SYSTEM_ONLY_OPERATIONS, ...ENV_OPERATIONS])) {
    for (const g of await perm.getOperationUserPermissions(documentId, op)) {
      const address = g.userAddress.toLowerCase();
      if (address === RESTRICTION_GRANTEE || address === keep) continue;
      await perm.revokeOperationPermission(documentId, op, g.userAddress);
    }
  }
}

/** id / owner / ownerOrgId from an environment document's global state. */
export function envProtectionTargetOf(doc: unknown): EnvProtectionTarget | null {
  const d = doc as { header?: { id?: unknown }; state?: { global?: Record<string, unknown> } };
  const id = d.header?.id;
  if (typeof id !== "string") return null;
  const state = d.state?.global ?? {};
  const operators = state.orgOperators;
  return {
    id,
    owner: typeof state.owner === "string" ? state.owner : null,
    ownerOrgId: typeof state.ownerOrgId === "string" ? state.ownerOrgId : null,
    orgOperators: Array.isArray(operators) ? operators.filter((o): o is string => typeof o === "string") : [],
  };
}

/**
 * reactorClient.subscribe handler: protects each created or updated
 * environment document right away (no reconciler window). Never throws.
 */
export function envChangeProtector(
  protect: (env: EnvProtectionTarget) => Promise<unknown>,
  logger: Pick<Console, "warn">,
): (event: { type: string; documents: unknown[] }) => void {
  return (event) => {
    const created: string = DocumentChangeType.Created;
    const updated: string = DocumentChangeType.Updated;
    if (event.type !== created && event.type !== updated) return;
    for (const doc of event.documents) {
      const env = envProtectionTargetOf(doc);
      if (!env) continue;
      void protect(env).catch((err: unknown) => {
        logger.warn(`[env-protection] ${env.id}: ${String(err)}`);
      });
    }
  };
}
