/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ApproveChangesInputSchema,
  ArchiveInputSchema,
  InitializeInputSchema,
  MarkChangesPushedInputSchema,
  MarkDeploymentStartedInputSchema,
  MarkDestroyedInputSchema,
  ReportDeploymentFailedInputSchema,
  ReportDeploymentSucceededInputSchema,
  TerminateEnvironmentInputSchema,
  UnarchiveInputSchema,
} from "../schema/zod.js";
import type {
  ApproveChangesInput,
  ArchiveInput,
  InitializeInput,
  MarkChangesPushedInput,
  MarkDeploymentStartedInput,
  MarkDestroyedInput,
  ReportDeploymentFailedInput,
  ReportDeploymentSucceededInput,
  TerminateEnvironmentInput,
  UnarchiveInput,
} from "../types.js";
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

export const initialize = (input: InitializeInput) =>
  createAction<InitializeAction>(
    "INITIALIZE",
    { ...input },
    undefined,
    InitializeInputSchema,
    "global",
  );

export const markChangesPushed = (input: MarkChangesPushedInput) =>
  createAction<MarkChangesPushedAction>(
    "MARK_CHANGES_PUSHED",
    { ...input },
    undefined,
    MarkChangesPushedInputSchema,
    "global",
  );

export const markDeploymentStarted = (input: MarkDeploymentStartedInput) =>
  createAction<MarkDeploymentStartedAction>(
    "MARK_DEPLOYMENT_STARTED",
    { ...input },
    undefined,
    MarkDeploymentStartedInputSchema,
    "global",
  );

export const reportDeploymentSucceeded = (
  input: ReportDeploymentSucceededInput,
) =>
  createAction<ReportDeploymentSucceededAction>(
    "REPORT_DEPLOYMENT_SUCCEEDED",
    { ...input },
    undefined,
    ReportDeploymentSucceededInputSchema,
    "global",
  );

export const reportDeploymentFailed = (input: ReportDeploymentFailedInput) =>
  createAction<ReportDeploymentFailedAction>(
    "REPORT_DEPLOYMENT_FAILED",
    { ...input },
    undefined,
    ReportDeploymentFailedInputSchema,
    "global",
  );

export const approveChanges = (input: ApproveChangesInput) =>
  createAction<ApproveChangesAction>(
    "APPROVE_CHANGES",
    { ...input },
    undefined,
    ApproveChangesInputSchema,
    "global",
  );

export const terminateEnvironment = (input: TerminateEnvironmentInput) =>
  createAction<TerminateEnvironmentAction>(
    "TERMINATE_ENVIRONMENT",
    { ...input },
    undefined,
    TerminateEnvironmentInputSchema,
    "global",
  );

export const markDestroyed = (input: MarkDestroyedInput) =>
  createAction<MarkDestroyedAction>(
    "MARK_DESTROYED",
    { ...input },
    undefined,
    MarkDestroyedInputSchema,
    "global",
  );

export const archive = (input: ArchiveInput) =>
  createAction<ArchiveAction>(
    "ARCHIVE",
    { ...input },
    undefined,
    ArchiveInputSchema,
    "global",
  );

export const unarchive = (input: UnarchiveInput) =>
  createAction<UnarchiveAction>(
    "UNARCHIVE",
    { ...input },
    undefined,
    UnarchiveInputSchema,
    "global",
  );
