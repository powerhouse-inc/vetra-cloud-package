import type { DocumentModelUtils } from "document-model";
import {
  baseCreateDocument,
  baseSaveToFileHandle,
  baseLoadFromInput,
  defaultBaseState,
  generateId,
} from "document-model";
import { reducer } from "./reducer.js";
import { vetraCloudEnvironmentDocumentType } from "./document-type.js";
import {
  assertIsVetraCloudEnvironmentDocument,
  assertIsVetraCloudEnvironmentState,
  isVetraCloudEnvironmentDocument,
  isVetraCloudEnvironmentState,
} from "./document-schema.js";
import type {
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentPHState,
} from "./types.js";

export const initialGlobalState: VetraCloudEnvironmentGlobalState = {
  label: null,
  genericSubdomain: null,
  genericBaseDomain: null,
  customDomain: {
    enabled: false,
    domain: null,
    dnsRecords: [],
  },
  defaultPackageRegistry: null,
  services: [],
  packages: [],
  status: "DRAFT",
};
export const initialLocalState: VetraCloudEnvironmentLocalState = {};

export const utils: DocumentModelUtils<VetraCloudEnvironmentPHState> = {
  fileExtension: "vce",
  createState(state) {
    return {
      ...defaultBaseState(),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    const document = baseCreateDocument(utils.createState, state);

    document.header.documentType = vetraCloudEnvironmentDocumentType;

    // for backwards compatibility, but this is NOT a valid signed document id
    document.header.id = generateId();

    return document;
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInput(input, reducer);
  },
  isStateOfType(state) {
    return isVetraCloudEnvironmentState(state);
  },
  assertIsStateOfType(state) {
    return assertIsVetraCloudEnvironmentState(state);
  },
  isDocumentOfType(document) {
    return isVetraCloudEnvironmentDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsVetraCloudEnvironmentDocument(document);
  },
};
