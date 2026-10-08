import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import { createReactorDocGateway } from "./doc-gateway.js";
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

export function createReactorLicenseGateway(
  client: LicenseGatewayClientLike,
): LicenseGateway {
  // Reducer rejections are only visible on the appended operations; without
  // that check a rejected transition would look applied and the keeper would
  // retry the same licence forever. See doc-gateway.ts.
  const docs = createReactorDocGateway(client, LICENSE_DOC_TYPE, "license");
  return {
    // No signer: the actions are system-signed, as in the env gateway.
    activate: (id) => docs.execute(id, [actions.activateLicense({})]),
    expire: (id) => docs.execute(id, [actions.expireLicense({})]),
    create: () => docs.create(),
    execute: (id, acts) => docs.execute(id, acts),
  };
}
