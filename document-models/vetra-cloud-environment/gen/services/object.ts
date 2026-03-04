import { BaseDocumentClass } from "document-model";
import { VetraCloudEnvironmentPHState } from "../ph-factories.js";
import { type EnableServiceInput, type DisableServiceInput } from "../types.js";
import { enableService, disableService } from "./creators.js";
import { type VetraCloudEnvironmentAction } from "../actions.js";

export default class VetraCloudEnvironment_Services extends BaseDocumentClass<VetraCloudEnvironmentPHState> {
  public enableService(input: EnableServiceInput) {
    return this.dispatch(enableService(input));
  }

  public disableService(input: DisableServiceInput) {
    return this.dispatch(disableService(input));
  }
}
