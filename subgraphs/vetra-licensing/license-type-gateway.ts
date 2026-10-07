import type { Action } from "document-model";
import { isDocumentNotFound } from "../vetra-apps/envs.js";

import type { LicenseGatewayClientLike } from "./license-gateway.js";
import { OperationRejectedError } from "./publisher-errors.js";
import { LICENSE_TYPE_DOC_TYPE } from "./reads.js";

export { LICENSE_TYPE_DOC_TYPE };

export interface LicenseTypeGateway {
  /** Creates an empty licence-type document and returns its id. */
  create(): Promise<string>;
  /** Applies actions to a licence-type document; throws if any is rejected. */
  execute(id: string, actions: Action[]): Promise<void>;
}

type DocLike = { header?: { revision?: Record<string, number> } };
type OpLike = {
  error?: string;
  action?: { id?: string; type?: string };
};

export function createReactorLicenseTypeGateway(
  client: LicenseGatewayClientLike,
): LicenseTypeGateway {
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
  // check a rejected PUBLISH_LICENSE_TYPE would look applied while the
  // document stayed in DRAFT.
  async function run(id: string, acts: Action[]): Promise<void> {
    const before = await getDoc(id);
    if (!before) throw new Error(`license type ${id} not found`);
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
        throw new OperationRejectedError(`${action.type} was not applied to license type ${id}`);
      }
      if (mine.error) {
        throw new OperationRejectedError(`${action.type} rejected: ${mine.error}`);
      }
    }
  }

  return {
    async create() {
      const doc = await client.createEmpty(LICENSE_TYPE_DOC_TYPE, {});
      return (doc.header as { id: string }).id;
    },
    execute: run,
  };
}
