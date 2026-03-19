import { type SignalDispatch } from "document-model";
import type {
  SetEnvironmentNameAction,
  SetSubdomainAction,
  SetCustomDomainAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentDataManagementOperations {
  setEnvironmentNameOperation: (
    state: VetraCloudEnvironmentState,
    action: SetEnvironmentNameAction,
    dispatch?: SignalDispatch,
  ) => void;
  setSubdomainOperation: (
    state: VetraCloudEnvironmentState,
    action: SetSubdomainAction,
    dispatch?: SignalDispatch,
  ) => void;
  setCustomDomainOperation: (
    state: VetraCloudEnvironmentState,
    action: SetCustomDomainAction,
    dispatch?: SignalDispatch,
  ) => void;
}
