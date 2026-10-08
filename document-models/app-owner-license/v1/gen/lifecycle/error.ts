export type ErrorCode =
  | "AlreadyIssuedError"
  | "EndBeforeStartError"
  | "MissingKindError"
  | "InvalidStatusTransitionError"
  | "NotIssuedError"
  | "AlreadyMigratedError";

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

export class MissingKindError extends Error implements ReducerError {
  errorCode = "MissingKindError" as ErrorCode;
  constructor(message = "MissingKindError") {
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

export class NotIssuedError extends Error implements ReducerError {
  errorCode = "NotIssuedError" as ErrorCode;
  constructor(message = "NotIssuedError") {
    super(message);
  }
}

export class AlreadyMigratedError extends Error implements ReducerError {
  errorCode = "AlreadyMigratedError" as ErrorCode;
  constructor(message = "AlreadyMigratedError") {
    super(message);
  }
}

export const errors = {
  IssueLicense: { AlreadyIssuedError, EndBeforeStartError, MissingKindError },

  ActivateLicense: { InvalidStatusTransitionError },

  ExpireLicense: { InvalidStatusTransitionError },

  RevokeLicense: { InvalidStatusTransitionError },

  ReplaceLicense: { InvalidStatusTransitionError },

  SetStage: { NotIssuedError },

  MigrateLicense: { NotIssuedError, AlreadyMigratedError },
};
