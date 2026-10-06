export type ErrorCode =
  | "AlreadyIssuedError"
  | "EndBeforeStartError"
  | "InvalidStatusTransitionError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class AlreadyIssuedError extends Error implements ReducerError {
  errorCode = "AlreadyIssuedError" as ErrorCode;
  constructor(message = "AlreadyIssuedError") {
    super(message);
  }
}

export class EndBeforeStartError extends Error implements ReducerError {
  errorCode = "EndBeforeStartError" as ErrorCode;
  constructor(message = "EndBeforeStartError") {
    super(message);
  }
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
  IssueLicense: { AlreadyIssuedError, EndBeforeStartError },

  ActivateLicense: { InvalidStatusTransitionError },

  ExpireLicense: { InvalidStatusTransitionError },

  RevokeLicense: { InvalidStatusTransitionError },

  ReplaceLicense: { InvalidStatusTransitionError },
};
