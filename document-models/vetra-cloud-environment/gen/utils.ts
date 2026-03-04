import {
  type CreateDocument,
  type CreateState,
  type LoadFromFile,
  type LoadFromInput,
  baseCreateDocument,
  baseSaveToFile,
  baseSaveToFileHandle,
  baseLoadFromFile,
  baseLoadFromInput,
  defaultBaseState,
  generateId,
} from "document-model";
import {
  type VetraCloudEnvironmentState,
  type VetraCloudEnvironmentLocalState,
} from "./types.js";
import { VetraCloudEnvironmentPHState } from "./ph-factories.js";
import { reducer } from "./reducer.js";

export const initialGlobalState: VetraCloudEnvironmentState = {
  name: null,
  services: [],
  packages: null,
  status: "STOPPED",
};
export const initialLocalState: VetraCloudEnvironmentLocalState = {};

export const createState: CreateState<VetraCloudEnvironmentPHState> = (
  state,
) => {
  return {
    ...defaultBaseState(),
    global: { ...initialGlobalState, ...(state?.global ?? {}) },
    local: { ...initialLocalState, ...(state?.local ?? {}) },
  };
};

export const createDocument: CreateDocument<VetraCloudEnvironmentPHState> = (
  state,
) => {
  const document = baseCreateDocument(createState, state);
  document.header.documentType = "powerhouse/vetra-cloud-environment";
  // for backwards compatibility, but this is NOT a valid signed document id
  document.header.id = generateId();
  return document;
};

export const saveToFile = (document: any, path: string, name?: string) => {
  return baseSaveToFile(document, path, "vce", name);
};

export const saveToFileHandle = (document: any, input: any) => {
  return baseSaveToFileHandle(document, input);
};

export const loadFromFile: LoadFromFile<VetraCloudEnvironmentPHState> = (
  path,
) => {
  return baseLoadFromFile(path, reducer);
};

export const loadFromInput: LoadFromInput<VetraCloudEnvironmentPHState> = (
  input,
) => {
  return baseLoadFromInput(input, reducer);
};

const utils = {
  fileExtension: "vce",
  createState,
  createDocument,
  saveToFile,
  saveToFileHandle,
  loadFromFile,
  loadFromInput,
};

export default utils;
