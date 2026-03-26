import { createAction } from "document-model/core";
import {
  EnableServiceInputSchema,
  DisableServiceInputSchema,
  ToggleServiceInputSchema,
  UpdateServicePrefixInputSchema,
  SetServiceStatusInputSchema,
} from "../schema/zod.js";
import type {
  EnableServiceInput,
  DisableServiceInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
  SetServiceStatusInput,
} from "../types.js";
import type {
  EnableServiceAction,
  DisableServiceAction,
  ToggleServiceAction,
  UpdateServicePrefixAction,
  SetServiceStatusAction,
} from "./actions.js";

export const enableService = (input: EnableServiceInput) =>
  createAction<EnableServiceAction>(
    "ENABLE_SERVICE",
    { ...input },
    undefined,
    EnableServiceInputSchema,
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
