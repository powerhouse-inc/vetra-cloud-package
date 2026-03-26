import type { Action } from "document-model";
import type {
  EnableServiceInput,
  DisableServiceInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
  SetServiceStatusInput,
} from "../types.js";

export type EnableServiceAction = Action & {
  type: "ENABLE_SERVICE";
  input: EnableServiceInput;
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

export type VetraCloudEnvironmentServicesAction =
  | EnableServiceAction
  | DisableServiceAction
  | ToggleServiceAction
  | UpdateServicePrefixAction
  | SetServiceStatusAction;
