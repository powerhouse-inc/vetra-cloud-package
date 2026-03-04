import { type SignalDispatch } from "document-model";
import { type StartAction, type StopAction } from "./actions.js";
import { type VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentStatusOperations {
  startOperation: (
    state: VetraCloudEnvironmentState,
    action: StartAction,
    dispatch?: SignalDispatch,
  ) => void;
  stopOperation: (
    state: VetraCloudEnvironmentState,
    action: StopAction,
    dispatch?: SignalDispatch,
  ) => void;
}
