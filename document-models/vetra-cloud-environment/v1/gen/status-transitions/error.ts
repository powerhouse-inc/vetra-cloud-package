export type ErrorCode = "InvalidStatusTransitionError";

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

export const errors = {
  Initialize: { InvalidStatusTransitionError },
  MarkChangesPushed: { InvalidStatusTransitionError },
  MarkDeploymentStarted: { InvalidStatusTransitionError },
  ReportDeploymentSucceeded: { InvalidStatusTransitionError },
  ReportDeploymentFailed: { InvalidStatusTransitionError },
  ApproveChanges: { InvalidStatusTransitionError },
  MarkDestroyed: { InvalidStatusTransitionError },
  Archive: { InvalidStatusTransitionError },
  Unarchive: { InvalidStatusTransitionError },
};
