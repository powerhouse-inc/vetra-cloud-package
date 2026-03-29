import type { Action } from "document-model";
import type {
  SetLabelInput,
  SetGenericSubdomainInput,
  SetCustomDomainInput,
  SetDefaultPackageRegistryInput,
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
export type SetDefaultPackageRegistryAction = Action & {
  type: "SET_DEFAULT_PACKAGE_REGISTRY";
  input: SetDefaultPackageRegistryInput;
};
export type SetDnsRecordsAction = Action & {
  type: "SET_DNS_RECORDS";
  input: SetDnsRecordsInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  | SetLabelAction
  | SetGenericSubdomainAction
  | SetCustomDomainAction
  | SetDefaultPackageRegistryAction
  | SetDnsRecordsAction;
