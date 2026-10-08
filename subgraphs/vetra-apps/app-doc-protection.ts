/**
 * vetra-app documents are system-write-only.
 *
 * With AUTH_ENABLED + DOCUMENT_PERMISSIONS_ENABLED any signed-in user may
 * write an unprotected document, and the vetra-app reducers do not authorise.
 * Licensing reads templates and terms from these documents, so each one is
 * protected with a single owner (the app's row owner, else the platform
 * publisher) and every other grant is revoked. The server's own reactor
 * client is not subject to these checks: reactor-api enforces them only in
 * its GraphQL/sync resolvers (assertCanWrite / assertCanExecuteOperation).
 *
 * Mirrors the env protection reconciler in vetra-cloud-observability.
 */

/**
 * The slice of the reactor client that reads and removes relationships.
 *
 * reactor-api inherits permissions down "child" relationships: a WRITE/ADMIN
 * grant on any ancestor (a source of an incoming "child" relationship) lets a
 * caller write the document, and addRelationship only checks the SOURCE. So
 * anyone could make their own drive the parent of a protected app document and
 * write it. App documents never legitimately have a parent.
 */
export interface RelationshipClient {
  getIncomingRelationships(
    targetIdentifier: string,
    relationshipType: string,
    view?: undefined,
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
  removeRelationship(
    sourceIdentifier: string,
    targetIdentifier: string,
    relationshipType: string,
  ): Promise<unknown>;
}

/** Ids of every document with a "child" relationship to `id`. Errors propagate. */
export async function incomingParentIds(
  rel: Pick<RelationshipClient, "getIncomingRelationships">,
  id: string,
): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  for (let page = 0; page < 50; page++) {
    const res = await rel.getIncomingRelationships(id, "child", undefined, { cursor, limit: 100 });
    for (const d of res.results) {
      const header = (d as { header?: { id?: unknown } } | null)?.header;
      out.push(typeof header?.id === "string" ? header.id : "<unknown>");
    }
    if (!res.nextCursor || res.nextCursor === cursor || res.results.length === 0) break;
    cursor = res.nextCursor;
  }
  return out;
}

/** Removes every incoming "child" relationship of an app document, logging each. */
export async function detachAppDocumentParents(
  rel: RelationshipClient,
  id: string,
  logger: Pick<Console, "warn">,
): Promise<number> {
  const parents = await incomingParentIds(rel, id);
  for (const parent of parents) {
    logger.warn(
      `[app-doc-protection] app document ${id} had parent ${parent} (its grants could write the app); removing the relationship`,
    );
    await rel.removeRelationship(parent, id, "child");
  }
  return parents.length;
}

/** The slice of reactor-api's DocumentPermissionService used here. */
export interface DocProtectionService {
  getDocumentProtection(
    documentId: string,
  ): Promise<{ protected: boolean; ownerAddress: string | null }>;
  initializeDocumentProtection(
    documentId: string,
    ownerAddress: string,
    defaultProtection?: boolean,
  ): Promise<void>;
  setDocumentProtection(documentId: string, isProtected: boolean): Promise<void>;
  getDocumentPermissions(
    documentId: string,
  ): Promise<{ userAddress: string }[]>;
  revokePermission(documentId: string, userAddress: string): Promise<void>;
}

/**
 * Protects one app document with `owner` as its only principal. Idempotent.
 * initializeDocumentProtection only seeds `protected` on first insert, and the
 * reactor often pre-creates the row unprotected, so the flag is set explicitly.
 */
export async function protectAppDocument(
  perm: DocProtectionService,
  documentId: string,
  owner: string,
): Promise<void> {
  const want = owner.toLowerCase();
  const current = await perm.getDocumentProtection(documentId);
  if (!current.protected || current.ownerAddress?.toLowerCase() !== want) {
    // Sets the owner and grants it ADMIN.
    await perm.initializeDocumentProtection(documentId, want, true);
    await perm.setDocumentProtection(documentId, true);
  }
  // A user who created the document through GraphQL holds an ADMIN grant
  // from that create; protection alone would leave them able to write.
  for (const g of await perm.getDocumentPermissions(documentId)) {
    if (g.userAddress.toLowerCase() !== want) {
      await perm.revokePermission(documentId, g.userAddress);
    }
  }
}

/**
 * Best-effort, idempotent: protects every listed app document. A failure on
 * one document is logged and the sweep continues; a failure to list is
 * logged and the sweep ends. Never throws.
 */
export async function sweepAppDocumentProtection(deps: {
  perm: DocProtectionService;
  relationships: RelationshipClient;
  listAppDocumentIds(): Promise<string[]>;
  ownerFor(id: string): Promise<string | null>;
  logger: Pick<Console, "warn" | "info">;
}): Promise<{ protected: number; failed: number; skipped: number }> {
  const result = { protected: 0, failed: 0, skipped: 0 };
  let ids: string[];
  try {
    ids = await deps.listAppDocumentIds();
  } catch (err) {
    deps.logger.warn(`[app-doc-protection] listing app documents failed: ${String(err)}`);
    return result;
  }
  for (const id of ids) {
    try {
      const owner = await deps.ownerFor(id);
      if (!owner) {
        deps.logger.warn(`[app-doc-protection] ${id}: no owner to protect with; skipped`);
        result.skipped++;
        continue;
      }
      await protectAppDocument(deps.perm, id, owner);
      await detachAppDocumentParents(deps.relationships, id, deps.logger);
      result.protected++;
    } catch (err) {
      deps.logger.warn(`[app-doc-protection] ${id}: protection failed: ${String(err)}`);
      result.failed++;
    }
  }
  deps.logger.info(
    `[app-doc-protection] swept ${ids.length} app documents: ${result.protected} protected, ${result.failed} failed, ${result.skipped} skipped`,
  );
  return result;
}

/**
 * Who an app document is protected for: the `apps` row owner, else the
 * platform publisher (the studio app, and any document without a row — which
 * nothing trusts, so it is simply taken away from whoever created it).
 */
export function createAppDocOwnerResolver(
  rowOwner: (id: string) => Promise<string | null>,
  platformOwner: string | null,
): (id: string) => Promise<string | null> {
  return async (id) => {
    const owner = await rowOwner(id);
    return owner ? owner.toLowerCase() : platformOwner;
  };
}

/** The create-time hook: protect a freshly created app document and detach any parent. */
export function createAppDocProtector(
  perm: DocProtectionService,
  ownerFor: (id: string) => Promise<string | null>,
  relationships: RelationshipClient,
  logger: Pick<Console, "warn">,
): (id: string) => Promise<void> {
  return async (id) => {
    const owner = await ownerFor(id);
    if (!owner) throw new Error(`no owner to protect app document ${id} with`);
    await protectAppDocument(perm, id, owner);
    await detachAppDocumentParents(relationships, id, logger);
  };
}
