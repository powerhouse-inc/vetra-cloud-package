import type { EditorModule } from "document-model";
import { VetraCloudEnvironment } from "./vetra-cloud-environment/module.js";

export const editors: EditorModule[] = [
  VetraCloudEnvironment,
];
