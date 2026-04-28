export type ErrorCode =
  | "NotOwnerError"
  | "ClintConfigRequiredError"
  | "PrefixInUseError"
  | "ServiceNotFoundError"
  | "NotClintServiceError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotOwnerError extends Error implements ReducerError {
  errorCode = "NotOwnerError" as ErrorCode;
  constructor(message = "NotOwnerError") {
    super(message);
  }
}

export class ClintConfigRequiredError extends Error implements ReducerError {
  errorCode = "ClintConfigRequiredError" as ErrorCode;
  constructor(message = "ClintConfigRequiredError") {
    super(message);
  }
}

export class PrefixInUseError extends Error implements ReducerError {
  errorCode = "PrefixInUseError" as ErrorCode;
  constructor(message = "PrefixInUseError") {
    super(message);
  }
}

export class ServiceNotFoundError extends Error implements ReducerError {
  errorCode = "ServiceNotFoundError" as ErrorCode;
  constructor(message = "ServiceNotFoundError") {
    super(message);
  }
}

export class NotClintServiceError extends Error implements ReducerError {
  errorCode = "NotClintServiceError" as ErrorCode;
  constructor(message = "NotClintServiceError") {
    super(message);
  }
}

export const errors = {
  EnableService: { NotOwnerError, ClintConfigRequiredError, PrefixInUseError },
  SetServiceConfig: { ServiceNotFoundError, NotClintServiceError },
  DisableService: { NotOwnerError },
  ToggleService: { ServiceNotFoundError, NotOwnerError },
  UpdateServicePrefix: { ServiceNotFoundError, NotOwnerError },
  SetServiceStatus: { ServiceNotFoundError, NotOwnerError },
  SetServiceVersion: { ServiceNotFoundError, NotOwnerError },
};
