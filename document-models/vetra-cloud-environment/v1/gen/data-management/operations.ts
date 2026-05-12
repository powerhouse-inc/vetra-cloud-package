import { type SignalDispatch } from "document-model";
import type {
  SetOwnerAction,
  SetLabelAction,
  SetGenericSubdomainAction,
  SetCustomDomainAction,
  SetDefaultPackageRegistryAction,
  SetDnsRecordsAction,
  SetApexServiceAction,
  SetAutoUpdateChannelAction,
  SetBackupScheduleAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentDataManagementOperations {
  setOwnerOperation: (
    state: VetraCloudEnvironmentState,
    action: SetOwnerAction,
    dispatch?: SignalDispatch,
  ) => void;
  setLabelOperation: (
    state: VetraCloudEnvironmentState,
    action: SetLabelAction,
    dispatch?: SignalDispatch,
  ) => void;
  setGenericSubdomainOperation: (
    state: VetraCloudEnvironmentState,
    action: SetGenericSubdomainAction,
    dispatch?: SignalDispatch,
  ) => void;
  setCustomDomainOperation: (
    state: VetraCloudEnvironmentState,
    action: SetCustomDomainAction,
    dispatch?: SignalDispatch,
  ) => void;
  setDefaultPackageRegistryOperation: (
    state: VetraCloudEnvironmentState,
    action: SetDefaultPackageRegistryAction,
    dispatch?: SignalDispatch,
  ) => void;
  setDnsRecordsOperation: (
    state: VetraCloudEnvironmentState,
    action: SetDnsRecordsAction,
    dispatch?: SignalDispatch,
  ) => void;
  setApexServiceOperation: (
    state: VetraCloudEnvironmentState,
    action: SetApexServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  setAutoUpdateChannelOperation: (
    state: VetraCloudEnvironmentState,
    action: SetAutoUpdateChannelAction,
    dispatch?: SignalDispatch,
  ) => void;
  setBackupScheduleOperation: (
    state: VetraCloudEnvironmentState,
    action: SetBackupScheduleAction,
    dispatch?: SignalDispatch,
  ) => void;
}
