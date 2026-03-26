import { type SignalDispatch } from "document-model";
import type {
  InitializeAction,
  MarkChangesPushedAction,
  MarkDeploymentStartedAction,
  ReportDeploymentSucceededAction,
  ReportDeploymentFailedAction,
  ApproveChangesAction,
  TerminateEnvironmentAction,
  MarkDestroyedAction,
  ArchiveAction,
  UnarchiveAction,
} from "./actions.js";
import type { VetraCloudEnvironmentState } from "../types.js";

export interface VetraCloudEnvironmentStatusTransitionsOperations {
  initializeOperation: (
    state: VetraCloudEnvironmentState,
    action: InitializeAction,
    dispatch?: SignalDispatch,
  ) => void;
  markChangesPushedOperation: (
    state: VetraCloudEnvironmentState,
    action: MarkChangesPushedAction,
    dispatch?: SignalDispatch,
  ) => void;
  markDeploymentStartedOperation: (
    state: VetraCloudEnvironmentState,
    action: MarkDeploymentStartedAction,
    dispatch?: SignalDispatch,
  ) => void;
  reportDeploymentSucceededOperation: (
    state: VetraCloudEnvironmentState,
    action: ReportDeploymentSucceededAction,
    dispatch?: SignalDispatch,
  ) => void;
  reportDeploymentFailedOperation: (
    state: VetraCloudEnvironmentState,
    action: ReportDeploymentFailedAction,
    dispatch?: SignalDispatch,
  ) => void;
  approveChangesOperation: (
    state: VetraCloudEnvironmentState,
    action: ApproveChangesAction,
    dispatch?: SignalDispatch,
  ) => void;
  terminateEnvironmentOperation: (
    state: VetraCloudEnvironmentState,
    action: TerminateEnvironmentAction,
    dispatch?: SignalDispatch,
  ) => void;
  markDestroyedOperation: (
    state: VetraCloudEnvironmentState,
    action: MarkDestroyedAction,
    dispatch?: SignalDispatch,
  ) => void;
  archiveOperation: (
    state: VetraCloudEnvironmentState,
    action: ArchiveAction,
    dispatch?: SignalDispatch,
  ) => void;
  unarchiveOperation: (
    state: VetraCloudEnvironmentState,
    action: UnarchiveAction,
    dispatch?: SignalDispatch,
  ) => void;
}
