/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ClearAppLinkInputSchema,
  SetApexServiceInputSchema,
  SetAppLinkInputSchema,
  SetAutoUpdateChannelInputSchema,
  SetBackupScheduleInputSchema,
  SetCustomDomainInputSchema,
  SetDefaultPackageRegistryInputSchema,
  SetDnsRecordsInputSchema,
  SetGenericSubdomainInputSchema,
  SetLabelInputSchema,
  SetNotificationWebhookInputSchema,
  SetOwnerInputSchema,
  SetOwnerOrgInputSchema,
  SetRuntimeConfigInputSchema,
  SetStudioInstanceInputSchema,
  SyncOrgOperatorsInputSchema,
} from "../schema/zod.js";
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
import type {
  ClearAppLinkAction,
  SetApexServiceAction,
  SetAppLinkAction,
  SetAutoUpdateChannelAction,
  SetBackupScheduleAction,
  SetCustomDomainAction,
  SetDefaultPackageRegistryAction,
  SetDnsRecordsAction,
  SetGenericSubdomainAction,
  SetLabelAction,
  SetNotificationWebhookAction,
  SetOwnerAction,
  SetOwnerOrgAction,
  SetRuntimeConfigAction,
  SetStudioInstanceAction,
  SyncOrgOperatorsAction,
} from "./actions.js";

export const setOwner = (input: SetOwnerInput) =>
  createAction<SetOwnerAction>(
    "SET_OWNER",
    { ...input },
    undefined,
    SetOwnerInputSchema,
    "global",
  );

export const setOwnerOrg = (input: SetOwnerOrgInput) =>
  createAction<SetOwnerOrgAction>(
    "SET_OWNER_ORG",
    { ...input },
    undefined,
    SetOwnerOrgInputSchema,
    "global",
  );

export const syncOrgOperators = (input: SyncOrgOperatorsInput) =>
  createAction<SyncOrgOperatorsAction>(
    "SYNC_ORG_OPERATORS",
    { ...input },
    undefined,
    SyncOrgOperatorsInputSchema,
    "global",
  );

export const setLabel = (input: SetLabelInput) =>
  createAction<SetLabelAction>(
    "SET_LABEL",
    { ...input },
    undefined,
    SetLabelInputSchema,
    "global",
  );

export const setGenericSubdomain = (input: SetGenericSubdomainInput) =>
  createAction<SetGenericSubdomainAction>(
    "SET_GENERIC_SUBDOMAIN",
    { ...input },
    undefined,
    SetGenericSubdomainInputSchema,
    "global",
  );

export const setCustomDomain = (input: SetCustomDomainInput) =>
  createAction<SetCustomDomainAction>(
    "SET_CUSTOM_DOMAIN",
    { ...input },
    undefined,
    SetCustomDomainInputSchema,
    "global",
  );

export const setDefaultPackageRegistry = (
  input: SetDefaultPackageRegistryInput,
) =>
  createAction<SetDefaultPackageRegistryAction>(
    "SET_DEFAULT_PACKAGE_REGISTRY",
    { ...input },
    undefined,
    SetDefaultPackageRegistryInputSchema,
    "global",
  );

export const setDnsRecords = (input: SetDnsRecordsInput) =>
  createAction<SetDnsRecordsAction>(
    "SET_DNS_RECORDS",
    { ...input },
    undefined,
    SetDnsRecordsInputSchema,
    "global",
  );

export const setApexService = (input: SetApexServiceInput) =>
  createAction<SetApexServiceAction>(
    "SET_APEX_SERVICE",
    { ...input },
    undefined,
    SetApexServiceInputSchema,
    "global",
  );

export const setAutoUpdateChannel = (input: SetAutoUpdateChannelInput) =>
  createAction<SetAutoUpdateChannelAction>(
    "SET_AUTO_UPDATE_CHANNEL",
    { ...input },
    undefined,
    SetAutoUpdateChannelInputSchema,
    "global",
  );

export const setRuntimeConfig = (input: SetRuntimeConfigInput) =>
  createAction<SetRuntimeConfigAction>(
    "SET_RUNTIME_CONFIG",
    { ...input },
    undefined,
    SetRuntimeConfigInputSchema,
    "global",
  );

export const setStudioInstance = (input: SetStudioInstanceInput) =>
  createAction<SetStudioInstanceAction>(
    "SET_STUDIO_INSTANCE",
    { ...input },
    undefined,
    SetStudioInstanceInputSchema,
    "global",
  );

export const setAppLink = (input: SetAppLinkInput) =>
  createAction<SetAppLinkAction>(
    "SET_APP_LINK",
    { ...input },
    undefined,
    SetAppLinkInputSchema,
    "global",
  );

export const clearAppLink = (input: ClearAppLinkInput) =>
  createAction<ClearAppLinkAction>(
    "CLEAR_APP_LINK",
    { ...input },
    undefined,
    ClearAppLinkInputSchema,
    "global",
  );

export const setBackupSchedule = (input: SetBackupScheduleInput) =>
  createAction<SetBackupScheduleAction>(
    "SET_BACKUP_SCHEDULE",
    { ...input },
    undefined,
    SetBackupScheduleInputSchema,
    "global",
  );

export const setNotificationWebhook = (input: SetNotificationWebhookInput) =>
  createAction<SetNotificationWebhookAction>(
    "SET_NOTIFICATION_WEBHOOK",
    { ...input },
    undefined,
    SetNotificationWebhookInputSchema,
    "global",
  );
