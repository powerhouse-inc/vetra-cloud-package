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
import { appLicenseTypeUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsAppLicenseTypeDocument,
  assertIsAppLicenseTypeState,
  isAppLicenseTypeDocument,
  isAppLicenseTypeState,
} from "./document-schema.js";
import { appLicenseTypeDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  AppLicenseTypeGlobalState,
  AppLicenseTypeLocalState,
  AppLicenseTypePHState,
} from "./types.js";

export const initialGlobalState: AppLicenseTypeGlobalState = {
  app: null,
  kind: null,
  label: null,
  validityDays: null,
  template: null,
  status: "DRAFT",
};
export const initialLocalState: AppLicenseTypeLocalState = {};

export const utils: DocumentModelUtils<AppLicenseTypePHState> = {
  fileExtension: "lict",
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
      appLicenseTypeDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: appLicenseTypeUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isAppLicenseTypeState(state);
  },
  assertIsStateOfType(state) {
    return assertIsAppLicenseTypeState(state);
  },
  isDocumentOfType(document) {
    return isAppLicenseTypeDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsAppLicenseTypeDocument(document);
  },
};
