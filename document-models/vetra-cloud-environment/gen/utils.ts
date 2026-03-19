import type { DocumentModelUtils } from "document-model";
import {
  baseCreateDocument,
  baseSaveToFileHandle,
  baseLoadFromInput,
  defaultBaseState,
  generateId,
} from "document-model/core";
import type {
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
} from "./types.js";
import type { VetraCloudEnvironmentPHState } from "./types.js";
import { reducer } from "./reducer.js";
import { vetraCloudEnvironmentDocumentType } from "./document-type.js";
import {
  isVetraCloudEnvironmentDocument,
  assertIsVetraCloudEnvironmentDocument,
  isVetraCloudEnvironmentState,
  assertIsVetraCloudEnvironmentState,
} from "./document-schema.js";

export const initialGlobalState: VetraCloudEnvironmentGlobalState = {
  name: null,
  subdomain: null,
  customDomain: null,
  services: [],
  packages: null,
  status: "STOPPED",
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

export const createDocument = utils.createDocument;
export const createState = utils.createState;
export const saveToFileHandle = utils.saveToFileHandle;
export const loadFromInput = utils.loadFromInput;
export const isStateOfType = utils.isStateOfType;
export const assertIsStateOfType = utils.assertIsStateOfType;
export const isDocumentOfType = utils.isDocumentOfType;
export const assertIsDocumentOfType = utils.assertIsDocumentOfType;
