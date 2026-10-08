import type { Action } from "document-model";
import { isDocumentNotFound } from "../vetra-apps/envs.js";
import type { LicenseGatewayClientLike } from "./license-gateway.js";
import { OperationRejectedError } from "./publisher-errors.js";

export interface DocGateway {
  create(): Promise<string>;
  /** Applies actions; throws OperationRejectedError if any is rejected or not applied. */
  execute(id: string, actions: Action[]): Promise<void>;
}

type DocLike = { header?: { revision?: Record<string, number> } };
type OpLike = { error?: string; action?: { id?: string; type?: string } };

/**
 * execute() returns a view without operations, so a reducer rejection is only
 * visible on the appended operations. One copy of that check for every
 * licensing document type (licences, app documents, legacy licence types).
 */
export function createReactorDocGateway(
  client: LicenseGatewayClientLike,
  docType: string,
  noun: string,
): DocGateway {
  async function getDoc(id: string): Promise<DocLike | null> {
    try {
      return ((await client.get(id)) as DocLike | null) ?? null;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }
  return {
    async create() {
      const doc = await client.createEmpty(docType, {});
      return (doc.header as { id: string }).id;
    },
    async execute(id, acts) {
      const before = await getDoc(id);
      if (!before) throw new Error(`${noun} ${id} not found`);
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
          throw new OperationRejectedError(`${action.type} was not applied to ${noun} ${id}`);
        }
        if (mine.error) {
          throw new OperationRejectedError(`${action.type} rejected: ${mine.error}`);
        }
      }
    },
  };
}
