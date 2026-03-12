import type { Action } from "document-model";
import type { SetEnvironmentNameInput } from "../types.js";

export type SetEnvironmentNameAction = Action & {
  type: "SET_ENVIRONMENT_NAME";
  input: SetEnvironmentNameInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  SetEnvironmentNameAction;
