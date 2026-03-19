import type { Action } from "document-model";
import type {
  SetEnvironmentNameInput,
  SetSubdomainInput,
  SetCustomDomainInput,
} from "../types.js";

export type SetEnvironmentNameAction = Action & {
  type: "SET_ENVIRONMENT_NAME";
  input: SetEnvironmentNameInput;
};
export type SetSubdomainAction = Action & {
  type: "SET_SUBDOMAIN";
  input: SetSubdomainInput;
};
export type SetCustomDomainAction = Action & {
  type: "SET_CUSTOM_DOMAIN";
  input: SetCustomDomainInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  | SetEnvironmentNameAction
  | SetSubdomainAction
  | SetCustomDomainAction;
