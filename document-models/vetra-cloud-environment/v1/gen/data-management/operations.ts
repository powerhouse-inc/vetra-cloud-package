/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraCloudEnvironmentGlobalState } from "../types.js";
import type {
  SetApexServiceAction,
  SetAutoUpdateChannelAction,
  SetCustomDomainAction,
  SetDefaultPackageRegistryAction,
  SetDnsRecordsAction,
  SetGenericSubdomainAction,
  SetLabelAction,
  SetOwnerAction,
  SetOwnerDriveAction,
} from "./actions.js";

export interface VetraCloudEnvironmentDataManagementOperations {
  setOwnerOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetOwnerAction,
    dispatch?: SignalDispatch,
  ) => void;
  setOwnerDriveOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetOwnerDriveAction,
    dispatch?: SignalDispatch,
  ) => void;
  setLabelOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetLabelAction,
    dispatch?: SignalDispatch,
  ) => void;
  setGenericSubdomainOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetGenericSubdomainAction,
    dispatch?: SignalDispatch,
  ) => void;
  setCustomDomainOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetCustomDomainAction,
    dispatch?: SignalDispatch,
  ) => void;
  setDefaultPackageRegistryOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetDefaultPackageRegistryAction,
    dispatch?: SignalDispatch,
  ) => void;
  setDnsRecordsOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetDnsRecordsAction,
    dispatch?: SignalDispatch,
  ) => void;
  setApexServiceOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetApexServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  setAutoUpdateChannelOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: SetAutoUpdateChannelAction,
    dispatch?: SignalDispatch,
  ) => void;
}
