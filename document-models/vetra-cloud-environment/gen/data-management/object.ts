import { BaseDocumentClass } from "document-model";
import { VetraCloudEnvironmentPHState } from "../ph-factories.js";
import { type SetEnvironmentNameInput } from "../types.js";
import { setEnvironmentName } from "./creators.js";
import { type VetraCloudEnvironmentAction } from "../actions.js";

export default class VetraCloudEnvironment_DataManagement extends BaseDocumentClass<VetraCloudEnvironmentPHState> {
  public setEnvironmentName(input: SetEnvironmentNameInput) {
    return this.dispatch(setEnvironmentName(input));
  }
}
