export type ErrorCode = "ServiceNotFoundError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class ServiceNotFoundError extends Error implements ReducerError {
  errorCode = "ServiceNotFoundError" as ErrorCode;
  constructor(message = "ServiceNotFoundError") {
    super(message);
  }
}

export const errors = {
  ToggleService: { ServiceNotFoundError },
  UpdateServicePrefix: { ServiceNotFoundError },
  SetServiceStatus: { ServiceNotFoundError },
  SetServiceVersion: { ServiceNotFoundError },
};
