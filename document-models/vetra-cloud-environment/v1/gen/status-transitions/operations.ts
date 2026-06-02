/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraCloudEnvironmentGlobalState } from "../types.js";
import type {
  ApproveChangesAction,
  ArchiveAction,
  InitializeAction,
  MarkChangesPushedAction,
  MarkDeploymentStartedAction,
  MarkDestroyedAction,
  ReportDeploymentFailedAction,
  ReportDeploymentSucceededAction,
  TerminateEnvironmentAction,
  UnarchiveAction,
} from "./actions.js";

export interface VetraCloudEnvironmentStatusTransitionsOperations {
  initializeOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: InitializeAction,
    dispatch?: SignalDispatch,
  ) => void;
  markChangesPushedOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: MarkChangesPushedAction,
    dispatch?: SignalDispatch,
  ) => void;
  markDeploymentStartedOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: MarkDeploymentStartedAction,
    dispatch?: SignalDispatch,
  ) => void;
  reportDeploymentSucceededOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: ReportDeploymentSucceededAction,
    dispatch?: SignalDispatch,
  ) => void;
  reportDeploymentFailedOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: ReportDeploymentFailedAction,
    dispatch?: SignalDispatch,
  ) => void;
  approveChangesOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: ApproveChangesAction,
    dispatch?: SignalDispatch,
  ) => void;
  terminateEnvironmentOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: TerminateEnvironmentAction,
    dispatch?: SignalDispatch,
  ) => void;
  markDestroyedOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: MarkDestroyedAction,
    dispatch?: SignalDispatch,
  ) => void;
  archiveOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: ArchiveAction,
    dispatch?: SignalDispatch,
  ) => void;
  unarchiveOperation: (
    state: VetraCloudEnvironmentGlobalState,
    action: UnarchiveAction,
    dispatch?: SignalDispatch,
  ) => void;
}
