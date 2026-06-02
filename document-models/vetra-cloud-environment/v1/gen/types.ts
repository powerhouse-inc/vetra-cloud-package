/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { VetraCloudEnvironmentAction } from "./actions.js";
import type { VetraCloudEnvironmentState as VetraCloudEnvironmentGlobalState } from "./schema/types.js";

type VetraCloudEnvironmentLocalState = Record<PropertyKey, never>;

type VetraCloudEnvironmentPHState = PHBaseState & {
  global: VetraCloudEnvironmentGlobalState;
  local: VetraCloudEnvironmentLocalState;
};
type VetraCloudEnvironmentDocument = PHDocument<VetraCloudEnvironmentPHState>;

export * from "./schema/types.js";

export type {
  VetraCloudEnvironmentAction,
  VetraCloudEnvironmentDocument,
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentPHState,
};
