import { type SignalDispatch } from "document-model";
import type {
  ToggleAutoUpdateAction,
  SetAutoUpdateChannelAction,
  SetImageTagAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentAutoUpdateOperations {
  toggleAutoUpdateOperation: (
    state: VetraCloudEnvironmentState,
    action: ToggleAutoUpdateAction,
    dispatch?: SignalDispatch,
  ) => void;
  setAutoUpdateChannelOperation: (
    state: VetraCloudEnvironmentState,
    action: SetAutoUpdateChannelAction,
    dispatch?: SignalDispatch,
  ) => void;
  setImageTagOperation: (
    state: VetraCloudEnvironmentState,
    action: SetImageTagAction,
    dispatch?: SignalDispatch,
  ) => void;
}
