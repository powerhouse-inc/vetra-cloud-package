/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { baseActions } from "document-model";
import {
  vetraCloudEnvironmentDataManagementActions,
  vetraCloudEnvironmentPackagesActions,
  vetraCloudEnvironmentServicesActions,
  vetraCloudEnvironmentStatusTransitionsActions,
} from "./gen/creators.js";

/** Actions for the VetraCloudEnvironment document model */

export const actions = {
  ...baseActions,
  ...vetraCloudEnvironmentDataManagementActions,
  ...vetraCloudEnvironmentServicesActions,
  ...vetraCloudEnvironmentPackagesActions,
  ...vetraCloudEnvironmentStatusTransitionsActions,
};
