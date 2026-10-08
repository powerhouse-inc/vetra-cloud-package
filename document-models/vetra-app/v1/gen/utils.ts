/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { DocumentModelUtils, PHBaseState, Reducer } from "document-model";
import {
  baseCreateDocument,
  baseLoadFromInputVersioned,
  baseSaveToFileHandle,
  createBaseState,
} from "document-model";
import { vetraAppUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsVetraAppDocument,
  assertIsVetraAppState,
  isVetraAppDocument,
  isVetraAppState,
} from "./document-schema.js";
import { vetraAppDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  VetraAppGlobalState,
  VetraAppLocalState,
  VetraAppPHState,
} from "./types.js";

export const initialGlobalState: VetraAppGlobalState = {
  name: null,
  slug: null,
  owner: null,
  status: "PENDING_IDENTITY",
  repository: null,
  identity: null,
  productionEnvironmentId: null,
  previews: null,
  artifacts: [],
  templates: [],
  terms: [],
};
export const initialLocalState: VetraAppLocalState = {};

export const utils: DocumentModelUtils<VetraAppPHState> = {
  fileExtension: "vapp",
  createState(state) {
    return {
      ...createBaseState(state?.auth, { version: 1, ...state?.document }),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    return baseCreateDocument(utils.createState, state, vetraAppDocumentType);
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: vetraAppUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isVetraAppState(state);
  },
  assertIsStateOfType(state) {
    return assertIsVetraAppState(state);
  },
  isDocumentOfType(document) {
    return isVetraAppDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsVetraAppDocument(document);
  },
};
