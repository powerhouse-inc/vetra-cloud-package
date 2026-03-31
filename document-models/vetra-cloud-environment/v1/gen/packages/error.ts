export type ErrorCode = "PackageNotFoundError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class PackageNotFoundError extends Error implements ReducerError {
  errorCode = "PackageNotFoundError" as ErrorCode;
  constructor(message = "PackageNotFoundError") {
    super(message);
  }
}

export const errors = {
  SetPackageVersion: { PackageNotFoundError },
};
