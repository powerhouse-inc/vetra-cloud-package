import type { DocumentModelModule } from "document-model";
import { VetraCloudEnvironment as VetraCloudEnvironmentV1 } from "./vetra-cloud-environment/v1/module.js";

export const documentModels: DocumentModelModule<any>[] = [
  VetraCloudEnvironmentV1,
];
