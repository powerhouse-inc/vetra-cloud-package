import type { DocumentModelModule } from "document-model";
import { createState } from "document-model";
import { defaultBaseState } from "document-model/core";
import type { VetraCloudEnvironmentPHState } from "vetra-cloud-package/document-models/vetra-cloud-environment";
import {
  actions,
  documentModel,
  reducer,
  utils,
} from "vetra-cloud-package/document-models/vetra-cloud-environment";

/** Document model module for the VetraCloudEnvironment document type */
export const VetraCloudEnvironment: DocumentModelModule<VetraCloudEnvironmentPHState> =
  {
    version: 1,
    reducer,
    actions,
    utils,
    documentModel: createState(defaultBaseState(), documentModel),
  };
