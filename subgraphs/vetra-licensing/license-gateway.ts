import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import { createReactorDocGateway } from "./doc-gateway.js";
import { LICENSE_DOC_TYPE, type LicenseClientLike } from "./reads.js";
import type { LifecycleStore } from "./lifecycle.js";

/** Narrow surface over the reactor client: only what the gateway uses. */
export interface LicenseGatewayClientLike {
  createEmpty(type: string, options: object): Promise<{ header: unknown }>;
  execute(id: string, branch: string, actions: Action[]): Promise<unknown>;
  get(id: string): Promise<unknown>;
  getOperations(
    id: string,
    view?: { branch?: string; scopes?: string[] },
    filter?: { sinceRevision?: number },
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
}

export interface LicenseGateway {
  /** ISSUED -> ACTIVE. Throws when the reducer rejects or the document is missing. */
  activate(id: string): Promise<void>;
  /** ISSUED|ACTIVE -> EXPIRED. Throws when the reducer rejects or the document is missing. */
  expire(id: string): Promise<void>;
  /** Creates an empty licence document and returns its id. */
  create(): Promise<string>;
  /** Applies actions to a licence document; throws if any is rejected. */
  execute(id: string, actions: Action[]): Promise<void>;
}

/** The write applied, but its lifecycle status could not be recorded; the keeper holds the chain. */
export class LifecycleNotRecordedError extends Error {
  override name = "LifecycleNotRecordedError";
}

export interface LicenseGatewayOptions {
  /**
   * Makes a new licence document system-write-only (app-doc-protection.ts),
   * right after create and before its id is handed out. Absent when document
   * permissions are off.
   */
  protect?: (id: string) => Promise<void>;
  /** Records the authoritative lifecycle status after every applied write (lifecycle.ts). */
  lifecycle?: Pick<LifecycleStore, "record">;
  logger?: Pick<Console, "error">;
}

export function createReactorLicenseGateway(
  client: LicenseGatewayClientLike,
  opts: LicenseGatewayOptions = {},
): LicenseGateway {
  // Reducer rejections are only visible on the appended operations; without
  // that check a rejected transition would look applied and the keeper would
  // retry the same licence forever. See doc-gateway.ts.
  const docs = createReactorDocGateway(client, LICENSE_DOC_TYPE, "license", opts.protect);
  const logger = opts.logger ?? console;
  async function execute(id: string, acts: Action[]): Promise<void> {
    await docs.execute(id, acts);
    const lifecycle = opts.lifecycle;
    if (!lifecycle) return;
    try {
      await lifecycle.record(id, acts);
    } catch (first) {
      try {
        await lifecycle.record(id, acts);
      } catch (err) {
        // Safe direction: the document moved but the record did not, so the
        // keeper sees a disagreement and holds the chain.
        logger.error(
          `[licensing] licence ${id}: ${acts.map((a) => a.type).join(", ")} applied but its lifecycle status was not recorded: ${String(err)} (first attempt: ${String(first)})`,
        );
        throw new LifecycleNotRecordedError(
          `licence ${id} was written but its lifecycle status could not be recorded`,
        );
      }
    }
  }
  return {
    // No signer: the actions are system-signed, as in the env gateway.
    activate: (id) => execute(id, [actions.activateLicense({})]),
    expire: (id) => execute(id, [actions.expireLicense({})]),
    create: () => docs.create(),
    execute,
  };
}

/** Every licence document id, well-formed or not: for the protection sweep. */
export async function listLicenceDocumentIds(client: LicenseClientLike): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  for (;;) {
    const page = await client.find({ type: LICENSE_DOC_TYPE }, undefined, { cursor, limit: 200 });
    for (const d of page.results) {
      const id = (d as { header?: { id?: unknown } } | null)?.header?.id;
      if (typeof id === "string") out.push(id);
    }
    if (!page.nextCursor || page.nextCursor === cursor) return out;
    cursor = page.nextCursor;
  }
}
