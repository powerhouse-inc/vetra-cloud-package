import { BaseDocumentClass } from "document-model";
import { VetraCloudEnvironmentPHState } from "../ph-factories.js";
import { type StartInput, type StopInput } from "../types.js";
import { start, stop } from "./creators.js";
import { type VetraCloudEnvironmentAction } from "../actions.js";

export default class VetraCloudEnvironment_Status extends BaseDocumentClass<VetraCloudEnvironmentPHState> {
  public start(input: StartInput) {
    return this.dispatch(start(input));
  }

  public stop(input: StopInput) {
    return this.dispatch(stop(input));
  }
}
