/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  ApproveChangesInput,
  ArchiveInput,
  InitializeInput,
  MarkChangesPushedInput,
  MarkDeploymentStartedInput,
  MarkDestroyedInput,
  ReportDeploymentFailedInput,
  ReportDeploymentSucceededInput,
  SleepEnvironmentInput,
  TerminateEnvironmentInput,
  UnarchiveInput,
  WakeEnvironmentInput,
} from "../types.js";

export type InitializeAction = Action & {
  type: "INITIALIZE";
  input: InitializeInput;
};
export type MarkChangesPushedAction = Action & {
  type: "MARK_CHANGES_PUSHED";
  input: MarkChangesPushedInput;
};
export type MarkDeploymentStartedAction = Action & {
  type: "MARK_DEPLOYMENT_STARTED";
  input: MarkDeploymentStartedInput;
};
export type ReportDeploymentSucceededAction = Action & {
  type: "REPORT_DEPLOYMENT_SUCCEEDED";
  input: ReportDeploymentSucceededInput;
};
export type ReportDeploymentFailedAction = Action & {
  type: "REPORT_DEPLOYMENT_FAILED";
  input: ReportDeploymentFailedInput;
};
export type ApproveChangesAction = Action & {
  type: "APPROVE_CHANGES";
  input: ApproveChangesInput;
};
export type TerminateEnvironmentAction = Action & {
  type: "TERMINATE_ENVIRONMENT";
  input: TerminateEnvironmentInput;
};
export type MarkDestroyedAction = Action & {
  type: "MARK_DESTROYED";
  input: MarkDestroyedInput;
};
export type ArchiveAction = Action & { type: "ARCHIVE"; input: ArchiveInput };
export type UnarchiveAction = Action & {
  type: "UNARCHIVE";
  input: UnarchiveInput;
};
export type SleepEnvironmentAction = Action & {
  type: "SLEEP_ENVIRONMENT";
  input: SleepEnvironmentInput;
};
export type WakeEnvironmentAction = Action & {
  type: "WAKE_ENVIRONMENT";
  input: WakeEnvironmentInput;
};

export type VetraCloudEnvironmentStatusTransitionsAction =
  | InitializeAction
  | MarkChangesPushedAction
  | MarkDeploymentStartedAction
  | ReportDeploymentSucceededAction
  | ReportDeploymentFailedAction
  | ApproveChangesAction
  | TerminateEnvironmentAction
  | MarkDestroyedAction
  | ArchiveAction
  | UnarchiveAction
  | SleepEnvironmentAction
  | WakeEnvironmentAction;
