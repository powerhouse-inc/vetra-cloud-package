import {
  BaseDocumentClass,
  applyMixins,
  type SignalDispatch,
} from "document-model";
import { VetraCloudEnvironmentPHState } from "./ph-factories.js";
import { type VetraCloudEnvironmentAction } from "./actions.js";
import { reducer } from "./reducer.js";
import { createDocument } from "./utils.js";
import VetraCloudEnvironment_DataManagement from "./data-management/object.js";
import VetraCloudEnvironment_Services from "./services/object.js";
import VetraCloudEnvironment_Packages from "./packages/object.js";
import VetraCloudEnvironment_Status from "./status/object.js";

export * from "./data-management/object.js";
export * from "./services/object.js";
export * from "./packages/object.js";
export * from "./status/object.js";

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
interface VetraCloudEnvironment
  extends VetraCloudEnvironment_DataManagement,
    VetraCloudEnvironment_Services,
    VetraCloudEnvironment_Packages,
    VetraCloudEnvironment_Status {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class VetraCloudEnvironment extends BaseDocumentClass<VetraCloudEnvironmentPHState> {
  static fileExtension = "vce";

  constructor(
    initialState?: Partial<VetraCloudEnvironmentPHState>,
    dispatch?: SignalDispatch,
  ) {
    super(reducer, createDocument(initialState), dispatch);
  }

  public saveToFile(path: string, name?: string) {
    return super.saveToFile(path, VetraCloudEnvironment.fileExtension, name);
  }

  public loadFromFile(path: string) {
    return super.loadFromFile(path);
  }

  static async fromFile(path: string) {
    const document = new this();
    await document.loadFromFile(path);
    return document;
  }
}

applyMixins(VetraCloudEnvironment, [
  VetraCloudEnvironment_DataManagement,
  VetraCloudEnvironment_Services,
  VetraCloudEnvironment_Packages,
  VetraCloudEnvironment_Status,
]);

export { VetraCloudEnvironment };
