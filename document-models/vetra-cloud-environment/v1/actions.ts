import { baseActions } from "document-model";
import {
  dataManagementActions,
  servicesActions,
  packagesActions,
  statusActions,
} from "./gen/creators.js";

/** Actions for the VetraCloudEnvironment document model */

export const actions = {
  ...baseActions,
  ...dataManagementActions,
  ...servicesActions,
  ...packagesActions,
  ...statusActions,
};
