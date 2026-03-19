import { createAction } from "document-model/core";
import {
  SetEnvironmentNameInputSchema,
  SetSubdomainInputSchema,
  SetCustomDomainInputSchema,
} from "../schema/zod.js";
import type {
  SetEnvironmentNameInput,
  SetSubdomainInput,
  SetCustomDomainInput,
} from "../types.js";
import type {
  SetEnvironmentNameAction,
  SetSubdomainAction,
  SetCustomDomainAction,
} from "./actions.js";

export const setEnvironmentName = (input: SetEnvironmentNameInput) =>
  createAction<SetEnvironmentNameAction>(
    "SET_ENVIRONMENT_NAME",
    { ...input },
    undefined,
    SetEnvironmentNameInputSchema,
    "global",
  );

export const setSubdomain = (input: SetSubdomainInput) =>
  createAction<SetSubdomainAction>(
    "SET_SUBDOMAIN",
    { ...input },
    undefined,
    SetSubdomainInputSchema,
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
