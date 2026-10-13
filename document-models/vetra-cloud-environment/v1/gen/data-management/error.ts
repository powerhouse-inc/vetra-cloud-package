export type ErrorCode =
  | "NotOwnerError"
  | "SelfClaimRequiredError"
  | "OrgOwnedError"
  | "OrgSyncSystemOnlyError"
  | "NotOrgOwnedError"
  | "ServiceNotEnabledError"
  | "InvalidRuntimeConfigError"
  | "AppLinkSystemOnlyError";

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

export class OrgOwnedError extends Error implements ReducerError {
  errorCode = "OrgOwnedError" as ErrorCode;
  constructor(message = "OrgOwnedError") {
    super(message);
  }
}

export class OrgSyncSystemOnlyError extends Error implements ReducerError {
  errorCode = "OrgSyncSystemOnlyError" as ErrorCode;
  constructor(message = "OrgSyncSystemOnlyError") {
    super(message);
  }
}

export class NotOrgOwnedError extends Error implements ReducerError {
  errorCode = "NotOrgOwnedError" as ErrorCode;
  constructor(message = "NotOrgOwnedError") {
    super(message);
  }
}

export class ServiceNotEnabledError extends Error implements ReducerError {
  errorCode = "ServiceNotEnabledError" as ErrorCode;
  constructor(message = "ServiceNotEnabledError") {
    super(message);
  }
}

export class InvalidRuntimeConfigError extends Error implements ReducerError {
  errorCode = "InvalidRuntimeConfigError" as ErrorCode;
  constructor(message = "InvalidRuntimeConfigError") {
    super(message);
  }
}

export class AppLinkSystemOnlyError extends Error implements ReducerError {
  errorCode = "AppLinkSystemOnlyError" as ErrorCode;
  constructor(message = "AppLinkSystemOnlyError") {
    super(message);
  }
}

export const errors = {
  SetOwner: { NotOwnerError, SelfClaimRequiredError },

  SetOwnerOrg: { NotOwnerError, OrgOwnedError },

  SyncOrgOperators: { OrgSyncSystemOnlyError, NotOrgOwnedError },

  SetLabel: { NotOwnerError },

  SetGenericSubdomain: { NotOwnerError },

  SetCustomDomain: { NotOwnerError },

  SetDefaultPackageRegistry: { NotOwnerError },

  SetDnsRecords: { NotOwnerError },

  SetApexService: { NotOwnerError, ServiceNotEnabledError },

  SetAutoUpdateChannel: { NotOwnerError },

  SetRuntimeConfig: { NotOwnerError, InvalidRuntimeConfigError },

  SetStudioInstance: { NotOwnerError },

  SetAppLink: { AppLinkSystemOnlyError },

  ClearAppLink: { AppLinkSystemOnlyError },
};
