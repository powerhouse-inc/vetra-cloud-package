import { type SignalDispatch } from "document-model";
import type {
  EnableServiceAction,
  DisableServiceAction,
  ToggleServiceAction,
  UpdateServicePrefixAction,
  SetServiceStatusAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentServicesOperations {
  enableServiceOperation: (
    state: VetraCloudEnvironmentState,
    action: EnableServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  disableServiceOperation: (
    state: VetraCloudEnvironmentState,
    action: DisableServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  toggleServiceOperation: (
    state: VetraCloudEnvironmentState,
    action: ToggleServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  updateServicePrefixOperation: (
    state: VetraCloudEnvironmentState,
    action: UpdateServicePrefixAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceStatusOperation: (
    state: VetraCloudEnvironmentState,
    action: SetServiceStatusAction,
    dispatch?: SignalDispatch,
  ) => void;
}
