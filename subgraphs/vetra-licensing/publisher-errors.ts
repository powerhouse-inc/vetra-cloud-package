import { GraphQLError } from "graphql";
import {
  UnauthenticatedError,
  AppIdentityInactiveError,
  UnknownAppIdentityError,
} from "./auth.js";
import { NotAppOwnerError, UnknownAppError } from "./publisher-auth.js";
import { LicensingDisabledError } from "./resolvers.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
  MultipleFusionServicesError,
  UnresolvedFusionServiceError,
} from "./template.js";
import { UnsupportedDidError } from "./did.js";
import { InvalidCodeError, InvalidCodeInputError } from "./invite-codes.js";
import { KeyStorageUnavailableError } from "./key-vault.js";
import { AlreadyHoldsError, LicenceNotUpgradableError, TermNotIssuableError } from "./issue.js";
import {
  AppEnvironmentCapReachedError,
  ChainBusyError,
  EnvironmentNotReadyError,
  EnvironmentOwnershipMismatchError,
} from "./environments.js";

/** The holder is not on the app's allow list (publisher grants). */
export class NotOnAllowListError extends Error {
  override name = "NotOnAllowListError";
}
/** Legacy machine grant path: the licence type is missing, inactive or another app's. */
export class LicenseTypeNotIssuableError extends Error {}
/** Legacy machine grant path: the holder is not a 0x address. */
export class InvalidHolderAddressError extends Error {}

/**
 * "Not yours" and "does not exist" are ONE error with a fixed message that
 * does not echo the id, for every id the publisher surface takes: a licence,
 * a template, a term, an invite code (as NotAppOwnerError / UnknownAppError do
 * for apps). A client must not be able to probe another publisher's ids.
 */
export class UnknownLicenseError extends Error {
  override name = "UnknownLicenseError";
  constructor() {
    super("no such licence");
  }
}
export class UnknownTemplateError extends Error {
  override name = "UnknownTemplateError";
  constructor() {
    super("no such template");
  }
}
export class UnknownTermError extends Error {
  override name = "UnknownTermError";
  constructor() {
    super("no such term");
  }
}
export class UnknownInviteCodeError extends Error {
  override name = "UnknownInviteCodeError";
  constructor() {
    super("no such invite code");
  }
}

/** No environment is known to be deployed as this tenant (applyStudioKey). */
export class UnknownTenantError extends Error {
  override name = "UnknownTenantError";
  constructor() {
    super("no such tenant");
  }
}

/** A secret name applyStudioKey may not write. */
export class InvalidSecretNameError extends Error {
  override name = "InvalidSecretNameError";
}

/** The caller is authenticated but may not do this. */
export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}

/**
 * The app document's licensing state was changed outside Vetra (the ledger
 * reports it tampered): everything read from it is untrusted and the keeper
 * holds the app, so the publisher surface refuses to build on it.
 */
export class AppTamperedError extends ForbiddenError {
  override name = "AppTamperedError";
  constructor(appId: string) {
    super(
      `app ${appId} is held: its licensing state was changed outside Vetra, so templates, terms and invite codes cannot be changed until it has been reviewed`,
    );
  }
}

/** A publisher argument is malformed (an unknown enum value, an invalid URL...). */
export class InvalidPublisherInputError extends Error {
  override name = "InvalidPublisherInputError";
}

/**
 * A reactor reducer refused an action ("<ACTION> rejected: <reason>") or never
 * applied it. Thrown by both licence gateways; the message is the stable text
 * they have always produced. Mapped to INVALID_INPUT: it is what an ordinary
 * publisher hits (incomplete term on publish, duplicates, wrong state).
 * Defined here, not in a gateway, so neither gateway imports the other.
 */
export class OperationRejectedError extends Error {
  override name = "OperationRejectedError";
}

/**
 * Map a licensing error to a GraphQLError carrying the contract's stable
 * `extensions.code` (2026-10-08-licensing-api-contract.md). Unknown errors
 * pass through unchanged.
 *
 * NotAppOwnerError and UnknownAppError share ONE code on purpose. They already
 * share their message text so that a publisher cannot distinguish another
 * publisher's app from a missing one; separate codes would hand back exactly
 * that oracle in machine-readable form.
 */
export function toLicensingGraphQLError(err: unknown): unknown {
  const code = codeFor(err);
  if (!code) return err;
  const e = err as Error;
  return new GraphQLError(e.message, { extensions: { code }, originalError: e });
}

/** The publisher surface's name for the same mapping. */
export const toPublisherGraphQLError = toLicensingGraphQLError;

/**
 * Built on use, not at module load: this module sits in an import cycle
 * (resolvers -> issuers/publisher-grant -> here -> resolvers, and issue.ts
 * -> here -> issue.ts), so a class
 * imported from a module still loading is not yet initialised at load time.
 */
const byCode = (): Array<[string, Array<abstract new (...a: never[]) => Error>]> => [
  ["UNAUTHENTICATED", [UnauthenticatedError]],
  [
    "NOT_FOUND",
    [
      NotAppOwnerError,
      UnknownAppError,
      UnknownLicenseError,
      UnknownTemplateError,
      UnknownTermError,
      UnknownInviteCodeError,
      UnknownTenantError,
    ],
  ],
  ["FORBIDDEN", [ForbiddenError, UnknownAppIdentityError]],
  ["APP_NOT_ACTIVE", [AppIdentityInactiveError]],
  ["NOT_ON_ALLOW_LIST", [NotOnAllowListError]],
  ["TERM_NOT_ISSUABLE", [TermNotIssuableError]],
  ["UNSUPPORTED_DID", [UnsupportedDidError]],
  ["LICENSING_DISABLED", [LicensingDisabledError]],
  ["INVALID_CODE", [InvalidCodeError]],
  ["ALREADY_HOLDS", [AlreadyHoldsError]],
  // Retryable: the chain is held by another caller, or its environment is
  // asleep or mid-transition. Nothing was done.
  ["BUSY", [ChainBusyError, EnvironmentNotReadyError]],
  [
    "INVALID_INPUT",
    [
      OperationRejectedError,
      InvalidPublisherInputError,
      InvalidCodeInputError,
      InvalidSecretNameError,
      LicenceNotUpgradableError,
      KeyStorageUnavailableError,
      UnknownTemplateSizeError,
      UnsupportedTemplateServiceError,
      MissingPackageNameError,
      InvalidHolderAddressError,
      LicenseTypeNotIssuableError,
      AppEnvironmentCapReachedError,
      EnvironmentOwnershipMismatchError,
      UnresolvedFusionServiceError,
      MultipleFusionServicesError,
    ],
  ],
];

function codeFor(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  for (const [code, classes] of byCode()) {
    if (classes.some((c) => err instanceof c)) return code;
  }
  return null;
}
