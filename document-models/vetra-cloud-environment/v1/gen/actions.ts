import type { VetraCloudEnvironmentDataManagementAction } from "./data-management/actions.js";
import type { VetraCloudEnvironmentServicesAction } from "./services/actions.js";
import type { VetraCloudEnvironmentPackagesAction } from "./packages/actions.js";
import type { VetraCloudEnvironmentStatusTransitionsAction } from "./status-transitions/actions.js";
import type { VetraCloudEnvironmentAutoUpdateAction } from "./auto-update/actions.js";

export * from "./data-management/actions.js";
export * from "./services/actions.js";
export * from "./packages/actions.js";
export * from "./status-transitions/actions.js";
export * from "./auto-update/actions.js";

export type VetraCloudEnvironmentAction =
  | VetraCloudEnvironmentDataManagementAction
  | VetraCloudEnvironmentServicesAction
  | VetraCloudEnvironmentPackagesAction
  | VetraCloudEnvironmentStatusTransitionsAction
  | VetraCloudEnvironmentAutoUpdateAction;
