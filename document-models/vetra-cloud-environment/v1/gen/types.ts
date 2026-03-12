import type { PHDocument, PHBaseState } from "document-model";
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
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentPHState,
  VetraCloudEnvironmentAction,
  VetraCloudEnvironmentDocument,
};
