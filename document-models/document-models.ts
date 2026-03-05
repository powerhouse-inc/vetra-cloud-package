import type { DocumentModelModule } from "document-model";
import { VetraCloudEnvironment } from "./vetra-cloud-environment/module.js";

export const documentModels: DocumentModelModule<any>[] = [
  VetraCloudEnvironment,
];
