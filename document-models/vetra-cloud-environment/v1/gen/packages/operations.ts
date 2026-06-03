/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraCloudEnvironmentGlobalState } from "../types.js";
import type {
  AddPackageAction,
  RemovePackageAction,
  SetPackageVersionAction,
} from "./actions.js";

export interface VetraCloudEnvironmentPackagesOperations {
  addPackageOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: AddPackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  removePackageOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: RemovePackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  setPackageVersionOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetPackageVersionAction,
    dispatch?: SignalDispatch,
  ) => void;
}
