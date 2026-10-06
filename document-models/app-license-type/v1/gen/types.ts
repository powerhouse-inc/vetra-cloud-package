/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { AppLicenseTypeAction } from "./actions.js";
import type { AppLicenseTypeState as AppLicenseTypeGlobalState } from "./schema/types.js";

type AppLicenseTypeLocalState = Record<PropertyKey, never>;

type AppLicenseTypePHState = PHBaseState & {
  global: AppLicenseTypeGlobalState;
  local: AppLicenseTypeLocalState;
};
type AppLicenseTypeDocument = PHDocument<AppLicenseTypePHState>;

export * from "./schema/types.js";

export type {
  AppLicenseTypeAction,
  AppLicenseTypeDocument,
  AppLicenseTypeGlobalState,
  AppLicenseTypeLocalState,
  AppLicenseTypePHState,
};
