import { type SignalDispatch } from "document-model";
import {
  type EnableServiceAction,
  type DisableServiceAction,
} from "./actions.js";
import { type VetraCloudEnvironmentState } from "../types.js";

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
}
