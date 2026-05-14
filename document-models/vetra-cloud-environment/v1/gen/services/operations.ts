/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraCloudEnvironmentGlobalState } from "../types.js";
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

export interface VetraCloudEnvironmentServicesOperations {
  enableServiceOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: EnableServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceConfigOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetServiceConfigAction,
    dispatch?: SignalDispatch,
  ) => void;
  disableServiceOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: DisableServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  toggleServiceOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: ToggleServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  updateServicePrefixOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: UpdateServicePrefixAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceStatusOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetServiceStatusAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceVersionOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetServiceVersionAction,
    dispatch?: SignalDispatch,
  ) => void;
  setServiceSizeOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetServiceSizeAction,
    dispatch?: SignalDispatch,
  ) => void;
}
