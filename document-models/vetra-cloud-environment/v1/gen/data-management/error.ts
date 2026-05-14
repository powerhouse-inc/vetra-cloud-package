export type ErrorCode =
  | "NotOwnerError"
  | "SelfClaimRequiredError"
  | "OwnerDriveMismatchError"
  | "ServiceNotEnabledError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotOwnerError extends Error implements ReducerError {
  errorCode = "NotOwnerError" as ErrorCode;
  constructor(message = "NotOwnerError") {
    super(message);
  }
}

export class SelfClaimRequiredError extends Error implements ReducerError {
  errorCode = "SelfClaimRequiredError" as ErrorCode;
  constructor(message = "SelfClaimRequiredError") {
    super(message);
  }
}

export class OwnerDriveMismatchError extends Error implements ReducerError {
  errorCode = "OwnerDriveMismatchError" as ErrorCode;
  constructor(message = "OwnerDriveMismatchError") {
    super(message);
  }
}

export class ServiceNotEnabledError extends Error implements ReducerError {
  errorCode = "ServiceNotEnabledError" as ErrorCode;
  constructor(message = "ServiceNotEnabledError") {
    super(message);
  }
}

export const errors = {
  SetOwner: { NotOwnerError, SelfClaimRequiredError },
  SetOwnerDrive: { OwnerDriveMismatchError },
  SetLabel: { NotOwnerError },
  SetGenericSubdomain: { NotOwnerError },
  SetCustomDomain: { NotOwnerError },
  SetDefaultPackageRegistry: { NotOwnerError },
  SetDnsRecords: { NotOwnerError },
  SetApexService: { NotOwnerError, ServiceNotEnabledError },
  SetAutoUpdateChannel: { NotOwnerError },
};
