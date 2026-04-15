export type ErrorCode = "NotOwnerError" | "ServiceNotFoundError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotOwnerError extends Error implements ReducerError {
  errorCode = "NotOwnerError" as ErrorCode;
  constructor(message = "NotOwnerError") {
    super(message);
  }
}

export class ServiceNotFoundError extends Error implements ReducerError {
  errorCode = "ServiceNotFoundError" as ErrorCode;
  constructor(message = "ServiceNotFoundError") {
    super(message);
  }
}

export const errors = {
  EnableService: { NotOwnerError },
  DisableService: { NotOwnerError },
  ToggleService: { ServiceNotFoundError, NotOwnerError },
  UpdateServicePrefix: { ServiceNotFoundError, NotOwnerError },
  SetServiceStatus: { ServiceNotFoundError, NotOwnerError },
  SetServiceVersion: { ServiceNotFoundError, NotOwnerError },
};
