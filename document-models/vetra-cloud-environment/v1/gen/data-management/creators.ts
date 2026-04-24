import { createAction } from "document-model";
import {
  SetOwnerInputSchema,
  SetLabelInputSchema,
  SetGenericSubdomainInputSchema,
  SetCustomDomainInputSchema,
  SetDefaultPackageRegistryInputSchema,
  SetDnsRecordsInputSchema,
  SetApexServiceInputSchema,
  SetAutoUpdateChannelInputSchema,
} from "../schema/zod.js";
import type {
  SetOwnerInput,
  SetLabelInput,
  SetGenericSubdomainInput,
  SetCustomDomainInput,
  SetDefaultPackageRegistryInput,
  SetDnsRecordsInput,
  SetApexServiceInput,
  SetAutoUpdateChannelInput,
} from "../types.js";
import type {
  SetOwnerAction,
  SetLabelAction,
  SetGenericSubdomainAction,
  SetCustomDomainAction,
  SetDefaultPackageRegistryAction,
  SetDnsRecordsAction,
  SetApexServiceAction,
  SetAutoUpdateChannelAction,
} from "./actions.js";

export const setOwner = (input: SetOwnerInput) =>
  createAction<SetOwnerAction>(
    "SET_OWNER",
    { ...input },
    undefined,
    SetOwnerInputSchema,
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
