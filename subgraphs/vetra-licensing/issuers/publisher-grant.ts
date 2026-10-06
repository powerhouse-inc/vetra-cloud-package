import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";

export class NotOnAllowListError extends Error {}
export class LicenseTypeNotIssuableError extends Error {}

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

  return documentId;
}
