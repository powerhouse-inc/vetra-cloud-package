import { GraphQLError } from "graphql";
import { UnauthenticatedError, AppIdentityInactiveError } from "./auth.js";
import { NotAppOwnerError, UnknownAppError } from "./publisher-auth.js";
import { LicensingDisabledError } from "./resolvers.js";
import { NegativeValidityError } from "../../document-models/app-license-type/v1/gen/license-type/error.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
} from "./template.js";

/** The holder is not on the app's allow list (publisher grants). */
export class NotOnAllowListError extends Error {}
/** Legacy grant path: the licence type is missing, inactive or another app's. */
export class LicenseTypeNotIssuableError extends Error {}
/** Legacy grant path: the holder is not a 0x address. */
export class InvalidHolderAddressError extends Error {}

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
 * A reactor reducer refused an action ("<ACTION> rejected: <reason>") or never
 * applied it. Thrown by both licence gateways; the message is the stable text
 * they have always produced. Mapped to INVALID_INPUT: it is what an ordinary
 * publisher hits (incomplete template on publish, duplicates, wrong state).
 * Defined here, not in a gateway, so neither gateway imports the other.
 */
export class OperationRejectedError extends Error {
  override name = "OperationRejectedError";
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
  // Currently unreachable: production wiring (index.ts) has isOnAllowList
  // always return true, as no allow-list store exists yet. Mapped now so the
  // first real allow list does not surface as INTERNAL_SERVER_ERROR (which
  // the dashboard retries).
  if (err instanceof NotOnAllowListError) return "NOT_ON_ALLOW_LIST";
  if (
    err instanceof OperationRejectedError ||
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
