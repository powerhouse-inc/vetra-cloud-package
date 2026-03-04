import { BaseDocumentClass } from "document-model";
import { VetraCloudEnvironmentPHState } from "../ph-factories.js";
import { type AddPackageInput, type RemovePackageInput } from "../types.js";
import { addPackage, removePackage } from "./creators.js";
import { type VetraCloudEnvironmentAction } from "../actions.js";

export default class VetraCloudEnvironment_Packages extends BaseDocumentClass<VetraCloudEnvironmentPHState> {
  public addPackage(input: AddPackageInput) {
    return this.dispatch(addPackage(input));
  }

  public removePackage(input: RemovePackageInput) {
    return this.dispatch(removePackage(input));
  }
}
