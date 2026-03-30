import { baseActions } from "document-model";
import {
  vetraCloudEnvironmentDataManagementActions,
  vetraCloudEnvironmentServicesActions,
  vetraCloudEnvironmentPackagesActions,
  vetraCloudEnvironmentStatusTransitionsActions,
  vetraCloudEnvironmentAutoUpdateActions,
} from "./gen/creators.js";

/** Actions for the VetraCloudEnvironment document model */

export const actions = {
  ...baseActions,
  ...vetraCloudEnvironmentDataManagementActions,
  ...vetraCloudEnvironmentServicesActions,
  ...vetraCloudEnvironmentPackagesActions,
  ...vetraCloudEnvironmentStatusTransitionsActions,
  ...vetraCloudEnvironmentAutoUpdateActions,
};
