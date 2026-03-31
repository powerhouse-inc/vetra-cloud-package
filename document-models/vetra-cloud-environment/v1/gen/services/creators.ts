import { createAction } from "document-model";
import {
  EnableServiceInputSchema,
  DisableServiceInputSchema,
  ToggleServiceInputSchema,
  UpdateServicePrefixInputSchema,
  SetServiceStatusInputSchema,
  SetServiceVersionInputSchema,
} from "../schema/zod.js";
import type {
  EnableServiceInput,
  DisableServiceInput,
  ToggleServiceInput,
  UpdateServicePrefixInput,
  SetServiceStatusInput,
  SetServiceVersionInput,
} from "../types.js";
import type {
  EnableServiceAction,
  DisableServiceAction,
  ToggleServiceAction,
  UpdateServicePrefixAction,
  SetServiceStatusAction,
  SetServiceVersionAction,
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

export const setServiceVersion = (input: SetServiceVersionInput) =>
  createAction<SetServiceVersionAction>(
    "SET_SERVICE_VERSION",
    { ...input },
    undefined,
    SetServiceVersionInputSchema,
    "global",
  );
