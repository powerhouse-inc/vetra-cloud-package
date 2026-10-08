/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
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

export type SetAppDetailsAction = Action & {
  type: "SET_APP_DETAILS";
  input: SetAppDetailsInput;
};
export type ConnectRepositoryAction = Action & {
  type: "CONNECT_REPOSITORY";
  input: ConnectRepositoryInput;
};
export type SetIdentityAction = Action & {
  type: "SET_IDENTITY";
  input: SetIdentityInput;
};
export type SetStatusAction = Action & {
  type: "SET_STATUS";
  input: SetStatusInput;
};
export type SetPreviewsAction = Action & {
  type: "SET_PREVIEWS";
  input: SetPreviewsInput;
};
export type SetProductionEnvironmentAction = Action & {
  type: "SET_PRODUCTION_ENVIRONMENT";
  input: SetProductionEnvironmentInput;
};
export type RecordArtifactVersionAction = Action & {
  type: "RECORD_ARTIFACT_VERSION";
  input: RecordArtifactVersionInput;
};
export type SetArtifactChannelAction = Action & {
  type: "SET_ARTIFACT_CHANNEL";
  input: SetArtifactChannelInput;
};

export type VetraAppAppAction =
  | SetAppDetailsAction
  | ConnectRepositoryAction
  | SetIdentityAction
  | SetStatusAction
  | SetPreviewsAction
  | SetProductionEnvironmentAction
  | RecordArtifactVersionAction
  | SetArtifactChannelAction;
