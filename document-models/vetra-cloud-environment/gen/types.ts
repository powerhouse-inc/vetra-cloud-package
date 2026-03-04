import type { PHDocument } from "document-model";
import type { VetraCloudEnvironmentAction } from "./actions.js";
import type { VetraCloudEnvironmentPHState } from "./ph-factories.js";
import type { VetraCloudEnvironmentState } from "./schema/types.js";

export { z } from "./schema/index.js";
export type * from "./schema/types.js";
type VetraCloudEnvironmentLocalState = Record<PropertyKey, never>;
export type VetraCloudEnvironmentDocument =
  PHDocument<VetraCloudEnvironmentPHState>;
export type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentAction,
};
