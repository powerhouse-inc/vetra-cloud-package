import { createAction } from "document-model";
import {
  ToggleAutoUpdateInputSchema,
  SetAutoUpdateChannelInputSchema,
  SetImageTagInputSchema,
} from "../schema/zod.js";
import type {
  ToggleAutoUpdateInput,
  SetAutoUpdateChannelInput,
  SetImageTagInput,
} from "../types.js";
import type {
  ToggleAutoUpdateAction,
  SetAutoUpdateChannelAction,
  SetImageTagAction,
} from "./actions.js";

export const toggleAutoUpdate = (input: ToggleAutoUpdateInput) =>
  createAction<ToggleAutoUpdateAction>(
    "TOGGLE_AUTO_UPDATE",
    { ...input },
    undefined,
    ToggleAutoUpdateInputSchema,
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

export const setImageTag = (input: SetImageTagInput) =>
  createAction<SetImageTagAction>(
    "SET_IMAGE_TAG",
    { ...input },
    undefined,
    SetImageTagInputSchema,
    "global",
  );
