import { GraphQLError } from "graphql";
import { UnauthenticatedError, AppIdentityInactiveError } from "./auth.js";
import { NotAppOwnerError, UnknownAppError } from "./publisher-auth.js";
import { LicensingDisabledError } from "./resolvers.js";
import {
  InvalidHolderAddressError,
  LicenseTypeNotIssuableError,
} from "./issuers/publisher-grant.js";
import { NegativeValidityError } from "../../document-models/app-license-type/v1/gen/license-type/error.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
} from "./template.js";

/**
 * Thrown by Tasks 6 and 7 for a licence type that is missing OR belongs to
 * another publisher. The message is fixed so the two cases are
 * indistinguishable, as with NotAppOwnerError.
 */
export class UnknownLicenseTypeError extends Error {
  override name = "UnknownLicenseTypeError";
  constructor() {
    super("no such licence type");
  }
}
/** As UnknownLicenseTypeError, for a licence. */
export class UnknownLicenseError extends Error {
  override name = "UnknownLicenseError";
  constructor() {
    super("no such licence");
  }
}

/**
 * Map a licensing error to a GraphQLError carrying a stable `extensions.code`.
 *
 * NotAppOwnerError and UnknownAppError share ONE code on purpose. They already
 * share their message text so that a publisher cannot distinguish another
 * publisher's app from a missing one; separate codes would hand back exactly
 * that oracle in machine-readable form.
 */
export function toPublisherGraphQLError(err: unknown): unknown {
  const code = codeFor(err);
  if (!code) return err;
  const e = err as Error;
  return new GraphQLError(e.message, { extensions: { code }, originalError: e });
}

function codeFor(err: unknown): string | null {
  if (err instanceof UnauthenticatedError) return "UNAUTHENTICATED";
  if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) {
    return "UNKNOWN_APP";
  }
  if (err instanceof AppIdentityInactiveError) return "APP_IDENTITY_INACTIVE";
  if (err instanceof LicensingDisabledError) return "LICENSING_DISABLED";
  if (err instanceof UnknownLicenseTypeError) return "UNKNOWN_LICENSE_TYPE";
  if (err instanceof UnknownLicenseError) return "UNKNOWN_LICENSE";
  if (
    err instanceof UnknownTemplateSizeError ||
    err instanceof UnsupportedTemplateServiceError ||
    err instanceof MissingPackageNameError ||
    err instanceof NegativeValidityError ||
    err instanceof InvalidHolderAddressError ||
    err instanceof LicenseTypeNotIssuableError
  ) {
    return "INVALID_INPUT";
  }
  return null;
}
