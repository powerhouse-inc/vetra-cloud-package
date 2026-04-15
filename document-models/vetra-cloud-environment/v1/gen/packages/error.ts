export type ErrorCode = "NotOwnerError" | "PackageNotFoundError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotOwnerError extends Error implements ReducerError {
  errorCode = "NotOwnerError" as ErrorCode;
  constructor(message = "NotOwnerError") {
    super(message);
  }
}

export class PackageNotFoundError extends Error implements ReducerError {
  errorCode = "PackageNotFoundError" as ErrorCode;
  constructor(message = "PackageNotFoundError") {
    super(message);
  }
}

export const errors = {
  AddPackage: { NotOwnerError },
  RemovePackage: { NotOwnerError },
  SetPackageVersion: { PackageNotFoundError, NotOwnerError },
};
