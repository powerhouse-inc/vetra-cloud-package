export type ErrorCode = "NotOwnerError" | "SelfClaimRequiredError";

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

export const errors = {
  SetOwner: { NotOwnerError, SelfClaimRequiredError },
  SetLabel: { NotOwnerError },
  SetGenericSubdomain: { NotOwnerError },
  SetCustomDomain: { NotOwnerError },
  SetDefaultPackageRegistry: { NotOwnerError },
  SetDnsRecords: { NotOwnerError },
};
