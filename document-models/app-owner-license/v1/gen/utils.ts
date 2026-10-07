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
import { appOwnerLicenseUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsAppOwnerLicenseDocument,
  assertIsAppOwnerLicenseState,
  isAppOwnerLicenseDocument,
  isAppOwnerLicenseState,
} from "./document-schema.js";
import { appOwnerLicenseDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  AppOwnerLicenseGlobalState,
  AppOwnerLicenseLocalState,
  AppOwnerLicensePHState,
} from "./types.js";

export const initialGlobalState: AppOwnerLicenseGlobalState = {
  app: null,
  licenseType: null,
  user: null,
  issuer: null,
  issuedBy: null,
  stage: null,
  details: null,
  issued: null,
  start: null,
  end: null,
  status: "ISSUED",
  replacedBy: null,
  revokedReason: null,
};
export const initialLocalState: AppOwnerLicenseLocalState = {};

export const utils: DocumentModelUtils<AppOwnerLicensePHState> = {
  fileExtension: "lic",
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
      appOwnerLicenseDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: appOwnerLicenseUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isAppOwnerLicenseState(state);
  },
  assertIsStateOfType(state) {
    return assertIsAppOwnerLicenseState(state);
  },
  isDocumentOfType(document) {
    return isAppOwnerLicenseDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsAppOwnerLicenseDocument(document);
  },
};
