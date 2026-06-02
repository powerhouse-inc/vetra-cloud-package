/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  SetApexServiceInput,
  SetAutoUpdateChannelInput,
  SetCustomDomainInput,
  SetDefaultPackageRegistryInput,
  SetDnsRecordsInput,
  SetGenericSubdomainInput,
  SetLabelInput,
  SetOwnerInput,
} from "../types.js";

export type SetOwnerAction = Action & {
  type: "SET_OWNER";
  input: SetOwnerInput;
};
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
export type SetApexServiceAction = Action & {
  type: "SET_APEX_SERVICE";
  input: SetApexServiceInput;
};
export type SetAutoUpdateChannelAction = Action & {
  type: "SET_AUTO_UPDATE_CHANNEL";
  input: SetAutoUpdateChannelInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  | SetOwnerAction
  | SetLabelAction
  | SetGenericSubdomainAction
  | SetCustomDomainAction
  | SetDefaultPackageRegistryAction
  | SetDnsRecordsAction
  | SetApexServiceAction
  | SetAutoUpdateChannelAction;
