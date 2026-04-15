export type ErrorCode = "InvalidStatusTransitionError" | "NotOwnerError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class InvalidStatusTransitionError
  extends Error
  implements ReducerError
{
  errorCode = "InvalidStatusTransitionError" as ErrorCode;
  constructor(message = "InvalidStatusTransitionError") {
    super(message);
  }
}

export class NotOwnerError extends Error implements ReducerError {
  errorCode = "NotOwnerError" as ErrorCode;
  constructor(message = "NotOwnerError") {
    super(message);
  }
}

export const errors = {
  Initialize: { InvalidStatusTransitionError, NotOwnerError },
  MarkChangesPushed: { InvalidStatusTransitionError },
  MarkDeploymentStarted: { InvalidStatusTransitionError },
  ReportDeploymentSucceeded: { InvalidStatusTransitionError },
  ReportDeploymentFailed: { InvalidStatusTransitionError },
  ApproveChanges: { InvalidStatusTransitionError, NotOwnerError },
  TerminateEnvironment: { NotOwnerError },
  MarkDestroyed: { InvalidStatusTransitionError, NotOwnerError },
  Archive: { InvalidStatusTransitionError, NotOwnerError },
  Unarchive: { InvalidStatusTransitionError, NotOwnerError },
};
