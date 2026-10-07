/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraAppGlobalState } from "../types.js";
import type {
  ConnectRepositoryAction,
  SetAppDetailsAction,
  SetIdentityAction,
  SetPreviewsAction,
  SetProductionEnvironmentAction,
  SetStatusAction,
} from "./actions.js";

export interface VetraAppAppOperations {
  setAppDetailsOperation: (
    state: VetraAppGlobalState,
    action: SetAppDetailsAction,
    dispatch?: SignalDispatch,
  ) => void;
  connectRepositoryOperation: (
    state: VetraAppGlobalState,
    action: ConnectRepositoryAction,
    dispatch?: SignalDispatch,
  ) => void;
  setIdentityOperation: (
    state: VetraAppGlobalState,
    action: SetIdentityAction,
    dispatch?: SignalDispatch,
  ) => void;
  setStatusOperation: (
    state: VetraAppGlobalState,
    action: SetStatusAction,
    dispatch?: SignalDispatch,
  ) => void;
  setPreviewsOperation: (
    state: VetraAppGlobalState,
    action: SetPreviewsAction,
    dispatch?: SignalDispatch,
  ) => void;
  setProductionEnvironmentOperation: (
    state: VetraAppGlobalState,
    action: SetProductionEnvironmentAction,
    dispatch?: SignalDispatch,
  ) => void;
}
