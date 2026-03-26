import { baseActions } from "document-model";
import {
  dataManagementActions,
  servicesActions,
  packagesActions,
  statusTransitionsActions,
} from "./gen/creators.js";

/** Actions for the VetraCloudEnvironment document model */

export const actions = {
  ...baseActions,
  ...dataManagementActions,
  ...servicesActions,
  ...packagesActions,
  ...statusTransitionsActions,
};
