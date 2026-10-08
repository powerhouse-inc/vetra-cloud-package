export type ErrorCode =
  | "DuplicateTemplateError"
  | "TemplateNotFoundError"
  | "SharedTemplateServicesError"
  | "DuplicateServiceError"
  | "ArtifactOnNonFusionServiceError"
  | "UnknownServiceError"
  | "DuplicatePackageError"
  | "UnknownPackageError"
  | "TemplateInUseError"
  | "DuplicateTermError"
  | "InvalidKindError"
  | "DuplicateKindError"
  | "NegativeValidityError"
  | "TermNotFoundError"
  | "KindImmutableError"
  | "TermIncompleteError"
  | "TermNotPublishedError";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class DuplicateTemplateError extends Error implements ReducerError {
  errorCode = "DuplicateTemplateError" as ErrorCode;
  constructor(message = "DuplicateTemplateError") {
    super(message);
  }
}

export class TemplateNotFoundError extends Error implements ReducerError {
  errorCode = "TemplateNotFoundError" as ErrorCode;
  constructor(message = "TemplateNotFoundError") {
    super(message);
  }
}

export class SharedTemplateServicesError extends Error implements ReducerError {
  errorCode = "SharedTemplateServicesError" as ErrorCode;
  constructor(message = "SharedTemplateServicesError") {
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

export class UnknownServiceError extends Error implements ReducerError {
  errorCode = "UnknownServiceError" as ErrorCode;
  constructor(message = "UnknownServiceError") {
    super(message);
  }
}

export class DuplicatePackageError extends Error implements ReducerError {
  errorCode = "DuplicatePackageError" as ErrorCode;
  constructor(message = "DuplicatePackageError") {
    super(message);
  }
}

export class UnknownPackageError extends Error implements ReducerError {
  errorCode = "UnknownPackageError" as ErrorCode;
  constructor(message = "UnknownPackageError") {
    super(message);
  }
}

export class TemplateInUseError extends Error implements ReducerError {
  errorCode = "TemplateInUseError" as ErrorCode;
  constructor(message = "TemplateInUseError") {
    super(message);
  }
}

export class DuplicateTermError extends Error implements ReducerError {
  errorCode = "DuplicateTermError" as ErrorCode;
  constructor(message = "DuplicateTermError") {
    super(message);
  }
}

export class InvalidKindError extends Error implements ReducerError {
  errorCode = "InvalidKindError" as ErrorCode;
  constructor(message = "InvalidKindError") {
    super(message);
  }
}

export class DuplicateKindError extends Error implements ReducerError {
  errorCode = "DuplicateKindError" as ErrorCode;
  constructor(message = "DuplicateKindError") {
    super(message);
  }
}

export class NegativeValidityError extends Error implements ReducerError {
  errorCode = "NegativeValidityError" as ErrorCode;
  constructor(message = "NegativeValidityError") {
    super(message);
  }
}

export class TermNotFoundError extends Error implements ReducerError {
  errorCode = "TermNotFoundError" as ErrorCode;
  constructor(message = "TermNotFoundError") {
    super(message);
  }
}

export class KindImmutableError extends Error implements ReducerError {
  errorCode = "KindImmutableError" as ErrorCode;
  constructor(message = "KindImmutableError") {
    super(message);
  }
}

export class TermIncompleteError extends Error implements ReducerError {
  errorCode = "TermIncompleteError" as ErrorCode;
  constructor(message = "TermIncompleteError") {
    super(message);
  }
}

export class TermNotPublishedError extends Error implements ReducerError {
  errorCode = "TermNotPublishedError" as ErrorCode;
  constructor(message = "TermNotPublishedError") {
    super(message);
  }
}

export const errors = {
  AddTemplate: { DuplicateTemplateError },

  SetTemplateDetails: { TemplateNotFoundError, SharedTemplateServicesError },

  AddTemplateService: {
    TemplateNotFoundError,
    SharedTemplateServicesError,
    DuplicateServiceError,
    ArtifactOnNonFusionServiceError,
  },

  RemoveTemplateService: { TemplateNotFoundError, UnknownServiceError },

  AddTemplatePackage: {
    TemplateNotFoundError,
    SharedTemplateServicesError,
    DuplicatePackageError,
  },

  RemoveTemplatePackage: { TemplateNotFoundError, UnknownPackageError },

  DeleteTemplate: { TemplateNotFoundError, TemplateInUseError },

  AddTerm: {
    DuplicateTermError,
    InvalidKindError,
    DuplicateKindError,
    TemplateNotFoundError,
    NegativeValidityError,
  },

  SetTermDetails: {
    TermNotFoundError,
    InvalidKindError,
    KindImmutableError,
    DuplicateKindError,
    TemplateNotFoundError,
    NegativeValidityError,
    TermIncompleteError,
  },

  PublishTerm: { TermNotFoundError, TermIncompleteError },

  RetireTerm: { TermNotFoundError, TermNotPublishedError },
};
