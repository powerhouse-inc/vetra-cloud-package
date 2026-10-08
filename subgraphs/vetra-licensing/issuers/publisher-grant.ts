import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import { normaliseUserDid } from "../did.js";
import type { GrantStore } from "../grants.js";
import { issueLicense, type IssueDeps } from "../issue.js";
import {
  InvalidHolderAddressError,
  LicenseTypeNotIssuableError,
  NotOnAllowListError,
  UnknownLicenseError,
} from "../publisher-errors.js";

// Defined in publisher-errors.ts (which maps them to GraphQL codes); re-exported
// so existing imports keep compiling.
export { InvalidHolderAddressError, LicenseTypeNotIssuableError, NotOnAllowListError };

/**
 * The subgraph's GraphQL input types the holder as `String`, but the document
 * model's ISSUE_LICENSE takes `EthereumAddress`. Validating here — before any
 * document is created — is what stops a malformed holder from leaving an empty
 * licence document behind for every rejected call.
 */
const ETHEREUM_ADDRESS = /^0x[a-f0-9]{40}$/;

export interface GrantDeps {
  isOnAllowList(appId: string, user: string): Promise<boolean>;
  getLicenseType(id: string): Promise<{
    id: string;
    app: string;
    status: string;
    validityDays: number | null;
  } | null>;
  createLicenseDocument(): Promise<string>;
  execute(documentId: string, actions: Action[]): Promise<unknown>;
  /**
   * Records that this licence was authorised by the app's owner. The keeper
   * provisions only licences with such a record, because the licence documents
   * themselves are system-signed and carry no provenance to check.
   */
  recordGrant(row: {
    licenseId: string;
    appId: string;
    licenseTypeId: string;
    user: string;
    issuedBy: string;
    now: string;
  }): Promise<void>;
}

export interface GrantInput {
  appId: string;
  licenseTypeId: string;
  user: string;
  issuedBy: string;
  /** ISO-8601 UTC `Z`, produced by toISOString(). */
  now: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The only writer in this slice. Every stored timestamp is fixed-width UTC `Z`
 * because transitions.ts compares them lexically, so `end` is derived with
 * toISOString() here (reducers are pure and must not compute dates).
 */
export async function issuePublisherGrant(
  deps: GrantDeps,
  input: GrantInput,
): Promise<string> {
  const user = input.user.toLowerCase();

  if (!ETHEREUM_ADDRESS.test(user)) {
    throw new InvalidHolderAddressError(
      `${input.user} is not a valid holder address`,
    );
  }

  if (!(await deps.isOnAllowList(input.appId, user))) {
    throw new NotOnAllowListError(
      `${user} is not on the allow list for app ${input.appId}`,
    );
  }

  const type = await deps.getLicenseType(input.licenseTypeId);
  if (!type || type.status !== "ACTIVE" || type.app !== input.appId) {
    throw new LicenseTypeNotIssuableError(
      `license type ${input.licenseTypeId} is not issuable for app ${input.appId}`,
    );
  }

  const start = new Date(Date.parse(input.now)).toISOString();
  const end =
    type.validityDays === null
      ? null
      : new Date(Date.parse(start) + type.validityDays * DAY_MS).toISOString();

  const documentId = await deps.createLicenseDocument();
  await deps.execute(documentId, [
    actions.issueLicense({
      app: input.appId,
      licenseType: type.id,
      user,
      issuer: "PUBLISHER_GRANT",
      issuedBy: input.issuedBy.toLowerCase(),
      stage: null,
      details: null,
      issued: start,
      start,
      end,
    }),
  ]);

  // After the document exists, so a failed issue never leaves an authorisation
  // for a licence that was not created.
  await deps.recordGrant({
    licenseId: documentId,
    appId: input.appId,
    licenseTypeId: type.id,
    user,
    issuedBy: input.issuedBy.toLowerCase(),
    now: start,
  });

  return documentId;
}

export interface PublisherGrantDeps extends IssueDeps {
  grants: IssueDeps["grants"] & Pick<GrantStore, "isOnAllowList">;
}

/**
 * PublisherGrantIssuer: an app's owner gives a holder on the allow list a
 * licence of one of the app's terms. The caller's ownership of the app is
 * checked by the resolver (resolveOwnerApp); issueLicense checks the app is
 * trusted and the term is issuable by PUBLISHER_GRANT.
 */
export async function grantLicense(
  deps: PublisherGrantDeps,
  input: {
    appId: string;
    kind: string;
    user: string;
    issuedBy: string;
    label: string | null;
    now: string;
  },
): Promise<string> {
  const user = normaliseUserDid(input.user);
  if (!(await deps.grants.isOnAllowList(input.appId, user))) {
    throw new NotOnAllowListError(`${user} is not on the allow list for app ${input.appId}`);
  }
  const issued = await issueLicense(deps, {
    appId: input.appId,
    user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase() },
    issuedBy: input.issuedBy,
    label: input.label,
    now: input.now,
  });
  return issued.licenseId;
}

/**
 * Upgrade/downgrade a holder in place: same chain, same environment.
 * `appId` is the app the caller was authorised for, read by the resolver from
 * the licence's grant row. It is never taken from the licence document, whose
 * `app` field is not system-write-only: issueLicense refuses a licence whose
 * document names another app exactly like a missing one.
 */
export async function replaceGrant(
  deps: PublisherGrantDeps,
  input: { appId: string; licenseId: string; kind: string; issuedBy: string; now: string },
): Promise<string> {
  const previous = await deps.licence(input.licenseId);
  if (!previous) throw new UnknownLicenseError();
  const issued = await issueLicense(deps, {
    appId: input.appId,
    user: previous.user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase(), replaces: previous.id },
    issuedBy: input.issuedBy,
    upgrades: previous.id,
    now: input.now,
  });
  return issued.licenseId;
}
