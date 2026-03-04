import { type Action } from "document-model";
import type { EnableServiceInput, DisableServiceInput } from "../types.js";

export type EnableServiceAction = Action & {
  type: "ENABLE_SERVICE";
  input: EnableServiceInput;
};
export type DisableServiceAction = Action & {
  type: "DISABLE_SERVICE";
  input: DisableServiceInput;
};

export type VetraCloudEnvironmentServicesAction =
  | EnableServiceAction
  | DisableServiceAction;
