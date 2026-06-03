/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  DisableServiceInputSchema,
  EnableServiceInputSchema,
  SetServiceConfigInputSchema,
  SetServiceSizeInputSchema,
  SetServiceStatusInputSchema,
  SetServiceVersionInputSchema,
  ToggleServiceInputSchema,
  UpdateServicePrefixInputSchema,
} from "../schema/zod.js";
import type {
  DisableServiceInput,
  EnableServiceInput,
  SetServiceConfigInput,
  SetServiceSizeInput,
  SetServiceStatusInput,
  SetServiceVersionInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
} from "../types.js";
import type {
  DisableServiceAction,
  EnableServiceAction,
  SetServiceConfigAction,
  SetServiceSizeAction,
  SetServiceStatusAction,
  SetServiceVersionAction,
  ToggleServiceAction,
  UpdateServicePrefixAction,
} from "./actions.js";

export const enableService = (input: EnableServiceInput) =>
  createAction<EnableServiceAction>(
    "ENABLE_SERVICE",
    { ...input },
    undefined,
    EnableServiceInputSchema,
    "global",
  );

export const setServiceConfig = (input: SetServiceConfigInput) =>
  createAction<SetServiceConfigAction>(
    "SET_SERVICE_CONFIG",
    { ...input },
    undefined,
    SetServiceConfigInputSchema,
    "global",
  );

export const disableService = (input: DisableServiceInput) =>
  createAction<DisableServiceAction>(
    "DISABLE_SERVICE",
    { ...input },
    undefined,
    DisableServiceInputSchema,
    "global",
  );

export const toggleService = (input: ToggleServiceInput) =>
  createAction<ToggleServiceAction>(
    "TOGGLE_SERVICE",
    { ...input },
    undefined,
    ToggleServiceInputSchema,
    "global",
  );

export const updateServicePrefix = (input: UpdateServicePrefixInput) =>
  createAction<UpdateServicePrefixAction>(
    "UPDATE_SERVICE_PREFIX",
    { ...input },
    undefined,
    UpdateServicePrefixInputSchema,
    "global",
  );

export const setServiceStatus = (input: SetServiceStatusInput) =>
  createAction<SetServiceStatusAction>(
    "SET_SERVICE_STATUS",
    { ...input },
    undefined,
    SetServiceStatusInputSchema,
    "global",
  );

export const setServiceVersion = (input: SetServiceVersionInput) =>
  createAction<SetServiceVersionAction>(
    "SET_SERVICE_VERSION",
    { ...input },
    undefined,
    SetServiceVersionInputSchema,
    "global",
  );

export const setServiceSize = (input: SetServiceSizeInput) =>
  createAction<SetServiceSizeAction>(
    "SET_SERVICE_SIZE",
    { ...input },
    undefined,
    SetServiceSizeInputSchema,
    "global",
  );
