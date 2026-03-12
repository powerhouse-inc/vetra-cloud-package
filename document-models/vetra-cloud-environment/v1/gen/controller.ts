import { PHDocumentController } from "document-model/core";
import { VetraCloudEnvironment } from "../module.js";
import type {
  VetraCloudEnvironmentAction,
  VetraCloudEnvironmentPHState,
} from "./types.js";

export const VetraCloudEnvironmentController =
  PHDocumentController.forDocumentModel<
    VetraCloudEnvironmentPHState,
    VetraCloudEnvironmentAction
  >(VetraCloudEnvironment);
