import type { Kysely } from "kysely";
import { DocumentChangeType } from "@powerhousedao/reactor";
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
 *    protection ownership moves away from the creator and every ADMIN grant is
 *    removed, so nobody but platform admins administers it from outside.
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
 * else the platform publisher (VETRA_STUDIO_PUBLISHER_ADDRESS, else the first
 * ADMINS entry, the identity Vetra already protects its own documents for),
 * else an address nobody can sign in as. Lowercased.
 */
export function vetraServiceAddress(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VETRA_SERVICE_ADDRESS?.trim() || env.VETRA_STUDIO_PUBLISHER_ADDRESS?.trim();
  if (explicit) return explicit.toLowerCase();
  const firstAdmin = (env.ADMINS ?? "")
    .split(",")
    .map((a) => a.trim())
    .find(Boolean);
  return (firstAdmin ?? RESTRICTION_GRANTEE).toLowerCase();
}

export interface EnvProtectionTarget {
  id: string;
  owner: string | null;
  ownerOrgId: string | null;
}

export interface EnvProtectionOptions {
  serviceOwner: string;
  /** Records protection hand-overs (org_document_protection); optional. */
  db?: Kysely<ObservabilityDB>;
  /** Per-process memo of restrictions already applied (`${id}|org` / `${id}|all`). */
  restricted?: Set<string>;
}

export type EnvProtectionResult = "UNOWNED" | "PERSONAL" | "ORG";

/**
 * Bring one environment document's reactor-api protection in line with its
 * owner / organisation. Idempotent; safe to run on every change.
 */
export async function protectEnvironment(
  perm: EnvProtectionService,
  env: EnvProtectionTarget,
  opts: EnvProtectionOptions,
): Promise<EnvProtectionResult> {
  const owned = !!env.owner || !!env.ownerOrgId;
  const ops = owned ? SYSTEM_ONLY_OPERATIONS : ORG_SYSTEM_OPERATIONS;
  const memo = `${env.id}|${owned ? "all" : "org"}`;
  if (!opts.restricted?.has(memo)) {
    await restrictSystemOperations(perm, env.id, ops);
    opts.restricted?.add(memo);
  }
  if (!owned) return "UNOWNED";

  if (env.ownerOrgId) {
    await protectForService(perm, env, opts);
    return "ORG";
  }

  const owner = (env.owner as string).toLowerCase();
  const current = await perm.getDocumentProtection(env.id);
  const ownerMatches = current.ownerAddress?.toLowerCase() === owner;
  if (!current.protected || !ownerMatches) {
    // initializeDocumentProtection seeds `protected` only on first insert; the
    // reactor often pre-creates the row unprotected, so set it explicitly.
    await perm.initializeDocumentProtection(env.id, owner, true);
    if (!current.protected) await perm.setDocumentProtection(env.id, true);
    if (!ownerMatches) {
      await perm.setDocumentOwner(env.id, owner);
      await perm.grantPermission(env.id, owner, "ADMIN", owner);
    }
  }
  if (opts.db) {
    // Back to a person (e.g. an org app transferred out): forget the hand-over
    // and withdraw the organisation grants Vetra made (only those still at the
    // level Vetra set; anything changed since belongs to someone else).
    const forgotten = await opts.db
      .deleteFrom("org_document_protection")
      .where("documentId", "=", env.id)
      .executeTakeFirst();
    if (Number(forgotten.numDeletedRows) === 0) return "PERSONAL";
    const grants = await opts.db
      .selectFrom("org_document_grants")
      .select(["address", "level"])
      .where("documentId", "=", env.id)
      .execute();
    for (const g of grants) {
      if (g.address !== owner && (await perm.getUserPermission(env.id, g.address)) === g.level) {
        await perm.revokePermission(env.id, g.address);
      }
      await opts.db
        .deleteFrom("org_document_grants")
        .where("documentId", "=", env.id)
        .where("address", "=", g.address)
        .execute();
    }
  }
  return "PERSONAL";
}

/**
 * Organisation env: protected, owned by the Vetra service identity, no ADMIN
 * grants left (the creator's and any previous owner's). Done once per
 * hand-over: a recorded hand-over whose owner is still the service is skipped.
 */
async function protectForService(
  perm: EnvProtectionService,
  env: EnvProtectionTarget,
  opts: EnvProtectionOptions,
): Promise<void> {
  const service = opts.serviceOwner.toLowerCase();
  const current = await perm.getDocumentProtection(env.id);
  const ownerIsService = current.ownerAddress?.toLowerCase() === service;
  const recorded = opts.db
    ? await opts.db
        .selectFrom("org_document_protection")
        .select("documentId")
        .where("documentId", "=", env.id)
        .executeTakeFirst()
    : undefined;
  if (current.protected && ownerIsService && recorded) return;

  // setDocumentOwner, not initializeDocumentProtection: the service needs no
  // ADMIN grant, being the protection owner is enough.
  if (!ownerIsService) await perm.setDocumentOwner(env.id, service);
  if (!current.protected) await perm.setDocumentProtection(env.id, true);
  for (const g of await perm.getDocumentPermissions(env.id)) {
    if (g.permission === "ADMIN") await perm.revokePermission(env.id, g.userAddress);
  }
  if (opts.db) {
    const now = new Date().toISOString();
    const previousOwner = ownerIsService ? null : (current.ownerAddress?.toLowerCase() ?? null);
    await opts.db
      .insertInto("org_document_protection")
      .values({ documentId: env.id, previousOwner, transferredAt: now })
      .onConflict((oc) => oc.column("documentId").doUpdateSet({ transferredAt: now }))
      .execute();
  }
}

/** id / owner / ownerOrgId from an environment document's global state. */
export function envProtectionTargetOf(doc: unknown): EnvProtectionTarget | null {
  const d = doc as { header?: { id?: unknown }; state?: { global?: Record<string, unknown> } };
  const id = d.header?.id;
  if (typeof id !== "string") return null;
  const state = d.state?.global ?? {};
  return {
    id,
    owner: typeof state.owner === "string" ? state.owner : null,
    ownerOrgId: typeof state.ownerOrgId === "string" ? state.ownerOrgId : null,
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
