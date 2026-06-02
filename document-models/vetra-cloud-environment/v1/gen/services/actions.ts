/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  DisableServiceInput,
  EnableServiceInput,
  SetServiceConfigInput,
  SetServiceSizeInput,
  SetServiceStatusInput,
  SetServiceVersionInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
} from "../types.js";

export type EnableServiceAction = Action & {
  type: "ENABLE_SERVICE";
  input: EnableServiceInput;
};
export type SetServiceConfigAction = Action & {
  type: "SET_SERVICE_CONFIG";
  input: SetServiceConfigInput;
};
export type DisableServiceAction = Action & {
  type: "DISABLE_SERVICE";
  input: DisableServiceInput;
};
export type ToggleServiceAction = Action & {
  type: "TOGGLE_SERVICE";
  input: ToggleServiceInput;
};
export type UpdateServicePrefixAction = Action & {
  type: "UPDATE_SERVICE_PREFIX";
  input: UpdateServicePrefixInput;
};
export type SetServiceStatusAction = Action & {
  type: "SET_SERVICE_STATUS";
  input: SetServiceStatusInput;
};
export type SetServiceVersionAction = Action & {
  type: "SET_SERVICE_VERSION";
  input: SetServiceVersionInput;
};
export type SetServiceSizeAction = Action & {
  type: "SET_SERVICE_SIZE";
  input: SetServiceSizeInput;
};

export type VetraCloudEnvironmentServicesAction =
  | EnableServiceAction
  | SetServiceConfigAction
  | DisableServiceAction
  | ToggleServiceAction
  | UpdateServicePrefixAction
  | SetServiceStatusAction
  | SetServiceVersionAction
  | SetServiceSizeAction;
