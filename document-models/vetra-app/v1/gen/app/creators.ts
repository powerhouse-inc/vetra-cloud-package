/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ConnectRepositoryInputSchema,
  RecordArtifactVersionInputSchema,
  SetAppDetailsInputSchema,
  SetArtifactChannelInputSchema,
  SetIdentityInputSchema,
  SetPreviewsInputSchema,
  SetProductionEnvironmentInputSchema,
  SetStatusInputSchema,
} from "../schema/zod.js";
import type {
  ConnectRepositoryInput,
  RecordArtifactVersionInput,
  SetAppDetailsInput,
  SetArtifactChannelInput,
  SetIdentityInput,
  SetPreviewsInput,
  SetProductionEnvironmentInput,
  SetStatusInput,
} from "../types.js";
import type {
  ConnectRepositoryAction,
  RecordArtifactVersionAction,
  SetAppDetailsAction,
  SetArtifactChannelAction,
  SetIdentityAction,
  SetPreviewsAction,
  SetProductionEnvironmentAction,
  SetStatusAction,
} from "./actions.js";

export const setAppDetails = (input: SetAppDetailsInput) =>
  createAction<SetAppDetailsAction>(
    "SET_APP_DETAILS",
    { ...input },
    undefined,
    SetAppDetailsInputSchema,
    "global",
  );

export const connectRepository = (input: ConnectRepositoryInput) =>
  createAction<ConnectRepositoryAction>(
    "CONNECT_REPOSITORY",
    { ...input },
    undefined,
    ConnectRepositoryInputSchema,
    "global",
  );

export const setIdentity = (input: SetIdentityInput) =>
  createAction<SetIdentityAction>(
    "SET_IDENTITY",
    { ...input },
    undefined,
    SetIdentityInputSchema,
    "global",
  );

export const setStatus = (input: SetStatusInput) =>
  createAction<SetStatusAction>(
    "SET_STATUS",
    { ...input },
    undefined,
    SetStatusInputSchema,
    "global",
  );

export const setPreviews = (input: SetPreviewsInput) =>
  createAction<SetPreviewsAction>(
    "SET_PREVIEWS",
    { ...input },
    undefined,
    SetPreviewsInputSchema,
    "global",
  );

export const setProductionEnvironment = (
  input: SetProductionEnvironmentInput,
) =>
  createAction<SetProductionEnvironmentAction>(
    "SET_PRODUCTION_ENVIRONMENT",
    { ...input },
    undefined,
    SetProductionEnvironmentInputSchema,
    "global",
  );

export const recordArtifactVersion = (input: RecordArtifactVersionInput) =>
  createAction<RecordArtifactVersionAction>(
    "RECORD_ARTIFACT_VERSION",
    { ...input },
    undefined,
    RecordArtifactVersionInputSchema,
    "global",
  );

export const setArtifactChannel = (input: SetArtifactChannelInput) =>
  createAction<SetArtifactChannelAction>(
    "SET_ARTIFACT_CHANNEL",
    { ...input },
    undefined,
    SetArtifactChannelInputSchema,
    "global",
  );
