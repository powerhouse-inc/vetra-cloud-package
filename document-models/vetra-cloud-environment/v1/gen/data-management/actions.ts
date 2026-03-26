import type { Action } from "document-model";
import type {
  SetLabelInput,
  SetGenericSubdomainInput,
  SetCustomDomainInput,
  SetDnsRecordsInput,
} from "../types.js";

export type SetLabelAction = Action & {
  type: "SET_LABEL";
  input: SetLabelInput;
};
export type SetGenericSubdomainAction = Action & {
  type: "SET_GENERIC_SUBDOMAIN";
  input: SetGenericSubdomainInput;
};
export type SetCustomDomainAction = Action & {
  type: "SET_CUSTOM_DOMAIN";
  input: SetCustomDomainInput;
};
export type SetDnsRecordsAction = Action & {
  type: "SET_DNS_RECORDS";
  input: SetDnsRecordsInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  | SetLabelAction
  | SetGenericSubdomainAction
  | SetCustomDomainAction
  | SetDnsRecordsAction;
