import { type SignalDispatch } from "document-model";
import type { SetEnvironmentNameAction } from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentDataManagementOperations {
  setEnvironmentNameOperation: (
    state: VetraCloudEnvironmentState,
    action: SetEnvironmentNameAction,
    dispatch?: SignalDispatch,
  ) => void;
}
