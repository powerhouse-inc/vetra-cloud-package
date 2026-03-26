import { createAction } from "document-model/core";
import {
  SetLabelInputSchema,
  SetGenericSubdomainInputSchema,
  SetCustomDomainInputSchema,
  SetDnsRecordsInputSchema,
} from "../schema/zod.js";
import type {
  SetLabelInput,
  SetGenericSubdomainInput,
  SetCustomDomainInput,
  SetDnsRecordsInput,
} from "../types.js";
import type {
  SetLabelAction,
  SetGenericSubdomainAction,
  SetCustomDomainAction,
  SetDnsRecordsAction,
} from "./actions.js";

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

export const setDnsRecords = (input: SetDnsRecordsInput) =>
  createAction<SetDnsRecordsAction>(
    "SET_DNS_RECORDS",
    { ...input },
    undefined,
    SetDnsRecordsInputSchema,
    "global",
  );
