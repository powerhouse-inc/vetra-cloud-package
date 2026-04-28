import { type SignalDispatch } from "document-model";
import type {
  EnableServiceAction,
  SetServiceConfigAction,
  DisableServiceAction,
  ToggleServiceAction,
  UpdateServicePrefixAction,
  SetServiceStatusAction,
  SetServiceVersionAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentServicesOperations {
  enableServiceOperation: (
    state: VetraCloudEnvironmentState,
    action: EnableServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceConfigOperation: (
    state: VetraCloudEnvironmentState,
    action: SetServiceConfigAction,
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
  setServiceVersionOperation: (
    state: VetraCloudEnvironmentState,
    action: SetServiceVersionAction,
    dispatch?: SignalDispatch,
  ) => void;
}
