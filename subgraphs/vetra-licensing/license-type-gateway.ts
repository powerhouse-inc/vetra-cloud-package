import type { Action } from "document-model";
import { createReactorDocGateway } from "./doc-gateway.js";
import type { LicenseGatewayClientLike } from "./license-gateway.js";
import { LICENSE_TYPE_DOC_TYPE } from "./reads.js";

export { LICENSE_TYPE_DOC_TYPE };

export interface LicenseTypeGateway {
  /** Creates an empty licence-type document and returns its id. */
  create(): Promise<string>;
  /** Applies actions to a licence-type document; throws if any is rejected. */
  execute(id: string, actions: Action[]): Promise<void>;
}

export function createReactorLicenseTypeGateway(
  client: LicenseGatewayClientLike,
): LicenseTypeGateway {
  // A rejected PUBLISH_LICENSE_TYPE must not look applied while the document
  // stays in DRAFT; doc-gateway.ts checks the appended operations.
  return createReactorDocGateway(client, LICENSE_TYPE_DOC_TYPE, "license type");
}
