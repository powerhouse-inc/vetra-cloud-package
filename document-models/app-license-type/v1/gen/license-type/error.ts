export type ErrorCode =
  | "NegativeValidityError"
  | "DuplicateServiceError"
  | "ArtifactOnNonFusionServiceError"
  | "DuplicatePackageError"
  | "UnknownServiceError"
  | "UnknownPackageError"
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

export class ArtifactOnNonFusionServiceError
  extends Error
  implements ReducerError
{
  errorCode = "ArtifactOnNonFusionServiceError" as ErrorCode;
  constructor(message = "ArtifactOnNonFusionServiceError") {
    super(message);
  }
}

export class DuplicatePackageError extends Error implements ReducerError {
  errorCode = "DuplicatePackageError" as ErrorCode;
  constructor(message = "DuplicatePackageError") {
    super(message);
  }
}

export class UnknownServiceError extends Error implements ReducerError {
  errorCode = "UnknownServiceError" as ErrorCode;
  constructor(message = "UnknownServiceError") {
    super(message);
  }
}

export class UnknownPackageError extends Error implements ReducerError {
  errorCode = "UnknownPackageError" as ErrorCode;
  constructor(message = "UnknownPackageError") {
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

  AddTemplateService: {
    DuplicateServiceError,
    ArtifactOnNonFusionServiceError,
  },

  AddTemplatePackage: { DuplicatePackageError },

  RemoveTemplateService: { UnknownServiceError },

  RemoveTemplatePackage: { UnknownPackageError },

  PublishLicenseType: { IncompleteTemplateError },

  RetireLicenseType: { NotPublishedError },
};
