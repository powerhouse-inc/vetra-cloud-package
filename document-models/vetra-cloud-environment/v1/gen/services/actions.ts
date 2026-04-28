import type { Action } from "document-model";
import type {
  EnableServiceInput,
  SetServiceConfigInput,
  DisableServiceInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
  SetServiceStatusInput,
  SetServiceVersionInput,
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

export type VetraCloudEnvironmentServicesAction =
  | EnableServiceAction
  | SetServiceConfigAction
  | DisableServiceAction
  | ToggleServiceAction
  | UpdateServicePrefixAction
  | SetServiceStatusAction
  | SetServiceVersionAction;
