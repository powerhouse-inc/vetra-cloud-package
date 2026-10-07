import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import { isDocumentNotFound } from "../vetra-apps/envs.js";

import { OperationRejectedError } from "./publisher-errors.js";
import { LICENSE_DOC_TYPE } from "./reads.js";

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

type DocLike = { header?: { revision?: Record<string, number> } };
type OpLike = {
  error?: string;
  action?: { id?: string; type?: string };
};

export function createReactorLicenseGateway(
  client: LicenseGatewayClientLike,
): LicenseGateway {
  async function getDoc(id: string): Promise<DocLike | null> {
    try {
      return ((await client.get(id)) as DocLike | null) ?? null;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }

  // execute() returns a view without operations, so a reducer rejection is
  // not thrown: it is only visible in the appended operations. Without this
  // check a rejected transition would look applied and the keeper would retry
  // the same licence forever.
  async function run(id: string, acts: Action[]): Promise<void> {
    const before = await getDoc(id);
    if (!before) throw new Error(`license ${id} not found`);
    const sinceRevision = before.header?.revision?.global ?? 0;
    await client.execute(id, "main", acts);

    const appended: OpLike[] = [];
    let cursor = "0";
    for (let page = 0; page < 20; page++) {
      const res = await client.getOperations(
        id,
        { branch: "main", scopes: ["global"] },
        { sinceRevision },
        { cursor, limit: 200 },
      );
      appended.push(...(res.results as OpLike[]));
      if (!res.nextCursor || res.results.length === 0) break;
      cursor = res.nextCursor;
    }
    for (const action of acts) {
      const mine = appended.find((op) => op.action?.id === action.id);
      if (!mine) {
        throw new OperationRejectedError(`${action.type} was not applied to license ${id}`);
      }
      if (mine.error) {
        throw new OperationRejectedError(`${action.type} rejected: ${mine.error}`);
      }
    }
  }

  return {
    // No signer: the actions are system-signed, as in the env gateway.
    activate: (id) => run(id, [actions.activateLicense({})]),
    expire: (id) => run(id, [actions.expireLicense({})]),
    async create() {
      const doc = await client.createEmpty(LICENSE_DOC_TYPE, {});
      return (doc.header as { id: string }).id;
    },
    execute: run,
  };
}
