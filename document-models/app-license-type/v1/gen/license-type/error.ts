export type ErrorCode =
  | "NegativeValidityError"
  | "DuplicateServiceError"
  | "DuplicatePackageError"
  | "IncompleteTemplateError"
  | "NotPublishedError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NegativeValidityError extends Error implements ReducerError {
  errorCode = "NegativeValidityError" as ErrorCode;
  constructor(message = "NegativeValidityError") {
    super(message);
  }
}

export class DuplicateServiceError extends Error implements ReducerError {
  errorCode = "DuplicateServiceError" as ErrorCode;
  constructor(message = "DuplicateServiceError") {
    super(message);
  }
}

export class DuplicatePackageError extends Error implements ReducerError {
  errorCode = "DuplicatePackageError" as ErrorCode;
  constructor(message = "DuplicatePackageError") {
    super(message);
  }
}

export class IncompleteTemplateError extends Error implements ReducerError {
  errorCode = "IncompleteTemplateError" as ErrorCode;
  constructor(message = "IncompleteTemplateError") {
    super(message);
  }
}

export class NotPublishedError extends Error implements ReducerError {
  errorCode = "NotPublishedError" as ErrorCode;
  constructor(message = "NotPublishedError") {
    super(message);
  }
}

export const errors = {
  SetLicenseTypeDetails: { NegativeValidityError },

  AddTemplateService: { DuplicateServiceError },

  AddTemplatePackage: { DuplicatePackageError },

  PublishLicenseType: { IncompleteTemplateError },

  RetireLicenseType: { NotPublishedError },
};
