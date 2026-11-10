export type ErrorCode =
  | "NotOwnerError"
  | "ClintConfigRequiredError"
  | "PrefixInUseError"
  | "ManagedByTemplateError"
  | "ServiceNotFoundError"
  | "NotClintServiceError"
  | "InvalidFusionConfigError";

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

export class ManagedByTemplateError extends Error implements ReducerError {
  errorCode = "ManagedByTemplateError" as ErrorCode;
  constructor(message = "ManagedByTemplateError") {
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

export class InvalidFusionConfigError extends Error implements ReducerError {
  errorCode = "InvalidFusionConfigError" as ErrorCode;
  constructor(message = "InvalidFusionConfigError") {
    super(message);
  }
}

export const errors = {
  EnableService: {
    NotOwnerError,
    ClintConfigRequiredError,
    PrefixInUseError,
    ManagedByTemplateError,
  },

  SetServiceConfig: { ServiceNotFoundError, NotClintServiceError },

  DisableService: { NotOwnerError, ManagedByTemplateError },

  ToggleService: {
    ServiceNotFoundError,
    NotOwnerError,
    ManagedByTemplateError,
  },

  UpdateServicePrefix: { ServiceNotFoundError, NotOwnerError },

  SetServiceStatus: { ServiceNotFoundError, NotOwnerError },

  SetServiceVersion: {
    ServiceNotFoundError,
    NotOwnerError,
    ManagedByTemplateError,
  },

  SetServiceSize: { ServiceNotFoundError, NotOwnerError },

  SetFusionConfig: { InvalidFusionConfigError, ManagedByTemplateError },
};
