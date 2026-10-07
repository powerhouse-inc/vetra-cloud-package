export type ErrorCode = "UnknownArtifactError" | "UnknownArtifactVersionError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class UnknownArtifactError extends Error implements ReducerError {
  errorCode = "UnknownArtifactError" as ErrorCode;
  constructor(message = "UnknownArtifactError") {
    super(message);
  }
}

export class UnknownArtifactVersionError extends Error implements ReducerError {
  errorCode = "UnknownArtifactVersionError" as ErrorCode;
  constructor(message = "UnknownArtifactVersionError") {
    super(message);
  }
}

export const errors = {
  SetArtifactChannel: { UnknownArtifactError, UnknownArtifactVersionError },
};
