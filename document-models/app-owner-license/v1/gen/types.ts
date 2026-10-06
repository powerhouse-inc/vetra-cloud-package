/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { AppOwnerLicenseAction } from "./actions.js";
import type { AppOwnerLicenseState as AppOwnerLicenseGlobalState } from "./schema/types.js";

type AppOwnerLicenseLocalState = Record<PropertyKey, never>;

type AppOwnerLicensePHState = PHBaseState & {
  global: AppOwnerLicenseGlobalState;
  local: AppOwnerLicenseLocalState;
};
type AppOwnerLicenseDocument = PHDocument<AppOwnerLicensePHState>;

export * from "./schema/types.js";

export type {
  AppOwnerLicenseAction,
  AppOwnerLicenseDocument,
  AppOwnerLicenseGlobalState,
  AppOwnerLicenseLocalState,
  AppOwnerLicensePHState,
};
