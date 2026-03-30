import type { Action } from "document-model";
import type {
  ToggleAutoUpdateInput,
  SetAutoUpdateChannelInput,
  SetImageTagInput,
} from "../types.js";

export type ToggleAutoUpdateAction = Action & {
  type: "TOGGLE_AUTO_UPDATE";
  input: ToggleAutoUpdateInput;
};
export type SetAutoUpdateChannelAction = Action & {
  type: "SET_AUTO_UPDATE_CHANNEL";
  input: SetAutoUpdateChannelInput;
};
export type SetImageTagAction = Action & {
  type: "SET_IMAGE_TAG";
  input: SetImageTagInput;
};

export type VetraCloudEnvironmentAutoUpdateAction =
  | ToggleAutoUpdateAction
  | SetAutoUpdateChannelAction
  | SetImageTagAction;
