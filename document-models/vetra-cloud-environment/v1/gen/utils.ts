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
import { vetraCloudEnvironmentUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsVetraCloudEnvironmentDocument,
  assertIsVetraCloudEnvironmentState,
  isVetraCloudEnvironmentDocument,
  isVetraCloudEnvironmentState,
} from "./document-schema.js";
import { vetraCloudEnvironmentDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentPHState,
} from "./types.js";

export const initialGlobalState: VetraCloudEnvironmentGlobalState = {
  owner: null,
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
  apexService: null,
  autoUpdateChannel: null,
  runtimeConfig: null,
};
export const initialLocalState: VetraCloudEnvironmentLocalState = {};

export const utils: DocumentModelUtils<VetraCloudEnvironmentPHState> = {
  fileExtension: "vce",
  createState(state) {
    return {
      ...createBaseState(state?.auth, { version: 1, ...state?.document }),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    return baseCreateDocument(
      utils.createState,
      state,
      vetraCloudEnvironmentDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: vetraCloudEnvironmentUpgradeManifest,
    });
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
