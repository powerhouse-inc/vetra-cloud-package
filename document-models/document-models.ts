import type { DocumentModelModule } from "document-model";
import { VetraCloudEnvironment } from "./vetra-cloud-environment/module.js";
import { VetraCloudEnvironment as VetraCloudEnvironmentV1 } from "./vetra-cloud-environment/v1/module.js";

export const documentModels: DocumentModelModule<any>[] = [
  VetraCloudEnvironment,
  VetraCloudEnvironmentV1,
];
