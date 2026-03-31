import { type SignalDispatch } from "document-model";
import type {
  AddPackageAction,
  RemovePackageAction,
  SetPackageVersionAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentPackagesOperations {
  addPackageOperation: (
    state: VetraCloudEnvironmentState,
    action: AddPackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  removePackageOperation: (
    state: VetraCloudEnvironmentState,
    action: RemovePackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  setPackageVersionOperation: (
    state: VetraCloudEnvironmentState,
    action: SetPackageVersionAction,
    dispatch?: SignalDispatch,
  ) => void;
}
