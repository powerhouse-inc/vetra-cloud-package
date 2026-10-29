/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  ClearAppLinkInput,
  SetApexServiceInput,
  SetAppLinkInput,
  SetAutoUpdateChannelInput,
  SetBackupScheduleInput,
  SetCustomDomainInput,
  SetDefaultPackageRegistryInput,
  SetDnsRecordsInput,
  SetGenericSubdomainInput,
  SetLabelInput,
  SetNotificationWebhookInput,
  SetOwnerInput,
  SetOwnerOrgInput,
  SetRuntimeConfigInput,
  SetStudioInstanceInput,
  SyncOrgOperatorsInput,
} from "../types.js";

export type SetOwnerAction = Action & {
  type: "SET_OWNER";
  input: SetOwnerInput;
};
export type SetOwnerOrgAction = Action & {
  type: "SET_OWNER_ORG";
  input: SetOwnerOrgInput;
};
export type SyncOrgOperatorsAction = Action & {
  type: "SYNC_ORG_OPERATORS";
  input: SyncOrgOperatorsInput;
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
export type SetRuntimeConfigAction = Action & {
  type: "SET_RUNTIME_CONFIG";
  input: SetRuntimeConfigInput;
};
export type SetStudioInstanceAction = Action & {
  type: "SET_STUDIO_INSTANCE";
  input: SetStudioInstanceInput;
};
export type SetAppLinkAction = Action & {
  type: "SET_APP_LINK";
  input: SetAppLinkInput;
};
export type ClearAppLinkAction = Action & {
  type: "CLEAR_APP_LINK";
  input: ClearAppLinkInput;
};
export type SetBackupScheduleAction = Action & {
  type: "SET_BACKUP_SCHEDULE";
  input: SetBackupScheduleInput;
};
export type SetNotificationWebhookAction = Action & {
  type: "SET_NOTIFICATION_WEBHOOK";
  input: SetNotificationWebhookInput;
};

export type VetraCloudEnvironmentDataManagementAction =
  | SetOwnerAction
  | SetOwnerOrgAction
  | SyncOrgOperatorsAction
  | SetLabelAction
  | SetGenericSubdomainAction
  | SetCustomDomainAction
  | SetDefaultPackageRegistryAction
  | SetDnsRecordsAction
  | SetApexServiceAction
  | SetAutoUpdateChannelAction
  | SetRuntimeConfigAction
  | SetStudioInstanceAction
  | SetAppLinkAction
  | ClearAppLinkAction
  | SetBackupScheduleAction
  | SetNotificationWebhookAction;
