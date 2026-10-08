import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import type { AppReads } from "./app-reads.js";
import { normaliseUserDid } from "./did.js";
import type { GrantStore } from "./grants.js";
import { keyedMutex } from "./keyed-mutex.js";
import type { PublisherAuthDeps } from "./publisher-auth.js";
import { OperationRejectedError, UnknownLicenseError } from "./publisher-errors.js";
import type { LicenceRecord } from "./reads.js";
import type { LifecycleStore } from "./lifecycle.js";

export type IssuerKind = "INVITE_CODE" | "PUBLISHER_GRANT" | "ACHRA_SUBSCRIPTION";

/**
 * The kind cannot be issued by this issuer for this app: the app is unknown,
 * untrusted (no `apps` row and not the studio app) or held as tampered, or the
 * term is missing, not ACTIVE, or does not list the issuer.
 */
export class TermNotIssuableError extends Error {
  override name = "TermNotIssuableError";
}
/** The licence is REPLACED or ISSUED, or is not the newest licence of its chain. */
export class LicenceNotUpgradableError extends Error {
  override name = "LicenceNotUpgradableError";
}
/**
 * The licence already is this kind, ACTIVE, on a term without a validity
 * limit: there is nothing to renew. (The same kind on a time-limited term is a
 * renewal, not a refusal.)
 */
export class AlreadyHoldsError extends Error {
  override name = "AlreadyHoldsError";
}

export interface IssueDeps {
  /**
   * Which apps are real. Ownership never comes from document state: an app
   * with no `apps` row (other than the studio app) is someone's unprotected
   * document, and its terms are not Vetra's to issue.
   */
  owners: Pick<PublisherAuthDeps, "findAppById">;
  /** Terms are read through app-reads, which flags a tampered document. */
  apps: Pick<AppReads, "app">;
  licence(id: string): Promise<LicenceRecord | null>;
  createLicenseDocument(): Promise<string>;
  executeLicence(id: string, actions: Action[]): Promise<void>;
  grants: Pick<GrantStore, "recordGrant" | "linkChain" | "chainRootOf" | "chainHead" | "grantFor">;
  /**
   * The recorded lifecycle (license_lifecycle), which decides a predecessor's
   * status and end over its document; `record` closes a predecessor whose
   * document refused REPLACE_LICENSE.
   */
  lifecycle: Pick<LifecycleStore, "entry" | "record">;
  /**
   * Whether the startup migration has completed (its `complete` marker).
   * Once it has, every licence the system vouches for has a lifecycle row, so
   * a predecessor without one is refused instead of trusting its document.
   */
  migrationComplete(): Promise<boolean>;
  logger: Pick<Console, "warn">;
}

export interface IssueInput {
  appId: string;
  user: string;
  kind: string;
  issuer: IssuerKind;
  /** Issuer-specific audit payload: invite code, grantor, subscription id. */
  details: Record<string, unknown>;
  issuedBy: string;
  label?: string | null;
  /**
   * Replace this licence (same app, same holder) and keep its environment.
   * Its holder and app come from its grant row, its status and end from its
   * lifecycle record: the document can only refuse, never decide. The same
   * kind on an ACTIVE licence is a renewal when the term is time-limited.
   */
  upgrades?: string | null;
  /** ISO-8601 UTC `Z`; the licence starts now (a renewal's end counts on from the predecessor's). */
  now: string;
}

export interface IssuedLicence {
  licenseId: string;
  user: string;
  end: string | null;
  replaced: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPGRADABLE = new Set(["ACTIVE", "EXPIRED", "REVOKED"]);

/**
 * Lifecycle writes to one licence run one at a time (in this process;
 * production runs a single replica): an upgrade holds its predecessor's key,
 * so a double-submitted upgrade sees the first one's successor and is refused
 * instead of forking the chain, and a revoke (publisher-resolvers) waits for
 * an upgrade in flight and then fails cleanly on the REPLACED licence.
 */
export const withLicenceLock = keyedMutex();

/** Two holder spellings name the same wallet (legacy licences carry a bare address). */
export function sameHolder(a: string, b: string): boolean {
  try {
    return normaliseUserDid(a) === normaliseUserDid(b);
  } catch {
    return false;
  }
}

/**
 * The one way a licence comes into existence. Everything that can refuse
 * refuses before a document is created, so a refusal never leaves an orphan.
 * The licence is issued AND activated in one batch: it starts now, and a
 * holder must not wait a keeper tick for access they were just given.
 */
export async function issueLicense(deps: IssueDeps, input: IssueInput): Promise<IssuedLicence> {
  return input.upgrades
    ? withLicenceLock(input.upgrades, () => issueUnlocked(deps, input))
    : issueUnlocked(deps, input);
}

async function issueUnlocked(deps: IssueDeps, input: IssueInput): Promise<IssuedLicence> {
  const user = normaliseUserDid(input.user);
  const notIssuable = (why: string) =>
    new TermNotIssuableError(
      `${input.kind} cannot be issued by ${input.issuer} for app ${input.appId}: ${why}`,
    );

  if (!(await deps.owners.findAppById(input.appId))) throw notIssuable("unknown app");
  const app = await deps.apps.app(input.appId);
  if (!app) throw notIssuable("unknown app");
  // Never issue from terms someone other than the system may have written.
  if (app.tampered) throw notIssuable(`the app is held (${app.tamperReason ?? "tampered"})`);
  const term = app.terms.find((t) => t.kind === input.kind);
  if (!term) throw notIssuable("no such term");
  if (term.status !== "ACTIVE") throw notIssuable(`the term is ${term.status}`);
  if (!term.issuers.includes(input.issuer)) throw notIssuable("the term does not allow this issuer");
  // As the public code check: a DEDICATED template whose artifacts do not
  // resolve could never be provisioned (the keeper would only hold the chain).
  const template = app.templates.find((t) => t.id === term.templateId);
  if (template?.mode === "DEDICATED" && template.resolutionError) {
    throw notIssuable(`its template cannot be resolved: ${template.resolutionError}`);
  }

  let previous: LicenceRecord | null = null;
  let previousStatus: string | null = null;
  /** The predecessor's end, by the record; null when open-ended or unknown. */
  let previousEnd: string | null = null;
  let renewal = false;
  let root: string | null = null;
  if (input.upgrades) {
    const doc = await deps.licence(input.upgrades);
    const grant = doc ? await deps.grants.grantFor(doc.id) : null;
    // Another holder's or another app's licence fails exactly like a missing
    // one. The holder and app are the grant row's; the document's own fields
    // can only add a refusal (a document disagreeing with its grant is not
    // upgraded), never name the holder.
    if (
      !doc ||
      !grant ||
      grant.appId !== input.appId ||
      grant.userDid !== user ||
      doc.app !== input.appId ||
      !sameHolder(doc.user, user)
    ) {
      throw new UnknownLicenseError();
    }
    // The status the system recorded. Before the migration completes, a
    // licence from before the record existed (no row yet) falls back to its
    // document; once it has completed, an unrecorded licence is not vouched
    // for by anything but its (forgeable) document, and is refused.
    const recorded = await deps.lifecycle.entry(doc.id);
    if (!recorded && (await deps.migrationComplete())) {
      throw new LicenceNotUpgradableError(
        `licence ${doc.id} has no recorded lifecycle; it cannot be upgraded or renewed`,
      );
    }
    previous = { ...doc, user, kind: grant.kind ?? doc.kind };
    previousStatus = recorded?.status ?? doc.status;
    // Never the document's end: a forged far-future end would otherwise be
    // carried into the renewal (and recorded as authority). Without a record
    // (a licence from before it existed) a renewal counts on from now.
    previousEnd = recorded?.endAt ?? null;
    if (!UPGRADABLE.has(previousStatus)) {
      throw new LicenceNotUpgradableError(
        `licence ${previous.id} is ${previousStatus}; only an ACTIVE, EXPIRED or REVOKED licence can be upgraded`,
      );
    }
    if (previousStatus === "ACTIVE" && previous.kind === input.kind) {
      // The same kind again: a time-limited term renews (the successor gets
      // the remaining time plus a full term); an unlimited one has nothing
      // to add.
      if (term.validityDays === null) {
        throw new AlreadyHoldsError(`licence ${previous.id} already is ${input.kind}, without an end`);
      }
      renewal = true;
    }
    // Only the newest licence of a chain can be upgraded: an older EXPIRED or
    // REVOKED one would otherwise fork the chain a second time.
    root = await deps.grants.chainRootOf(previous.id);
    const head = await deps.grants.chainHead(root);
    if (head !== previous.id) {
      throw new LicenceNotUpgradableError(
        `licence ${previous.id} has been succeeded by ${head}; upgrade the newest licence of the chain`,
      );
    }
  }

  const start = new Date(Date.parse(input.now)).toISOString();
  // A renewal counts on from max(predecessor's end, now): unused time is kept,
  // an end already past (the keeper has not expired it yet) adds nothing.
  const prevEndMs = previousEnd === null ? Number.NaN : Date.parse(previousEnd);
  const from =
    renewal && !Number.isNaN(prevEndMs) ? Math.max(prevEndMs, Date.parse(start)) : Date.parse(start);
  const end =
    term.validityDays === null
      ? null
      : new Date(from + term.validityDays * DAY_MS).toISOString();

  // Built before create(): the creator validates the input, so a malformed
  // action refuses here instead of after an empty document exists.
  const issueAction = actions.issueLicense({
    app: input.appId,
    user,
    issuer: input.issuer,
    kind: input.kind,
    stage: previous?.stage ?? null,
    details: JSON.stringify({ ...input.details, issuedBy: input.issuedBy.toLowerCase() }),
    issued: start,
    start,
    end,
  });

  const licenseId = await deps.createLicenseDocument();
  await deps.executeLicence(licenseId, [issueAction, actions.activateLicense({})]);
  // The chain first, then provenance: a chain row without provenance is
  // inert (the keeper provisions only authorised licences), but provenance
  // without a chain row would make an upgrade its own chain, and its own
  // second environment. Both after the document exists, so a failed issue
  // never leaves an authorisation for a licence that was not created.
  await deps.grants.linkChain({
    licenseId,
    rootLicenseId: root ?? licenseId,
    appId: input.appId,
    label: input.label ?? null,
    now: start,
  });
  await deps.grants.recordGrant({
    licenseId,
    appId: input.appId,
    kind: input.kind,
    userDid: user,
    issuedBy: input.issuedBy,
    now: start,
  });

  if (previous && previousStatus === "ACTIVE") {
    const replace = actions.replaceLicense({ replacedBy: licenseId });
    try {
      await deps.executeLicence(previous.id, [replace]);
    } catch (err) {
      // Safe to continue: both licences sit in one chain and the keeper serves
      // the newest ACTIVE one, so the holder never gets a second environment.
      deps.logger.warn(
        `[licensing] issued ${licenseId} but could not mark ${previous.id} REPLACED: ${String(err)}`,
      );
      if (err instanceof OperationRejectedError) {
        // The document refused although the record says ACTIVE: it was
        // changed outside the system (and already disagrees with the record,
        // so its chain is held for review). The record is the authority:
        // close it, so the chain never has two ACTIVE licences. A failure
        // that is not a refusal leaves the record alone, as the document may
        // still be ACTIVE.
        try {
          await deps.lifecycle.record(previous.id, [replace]);
        } catch (recordErr) {
          deps.logger.warn(
            `[licensing] could not record ${previous.id} REPLACED: ${String(recordErr)}`,
          );
        }
      }
    }
  }
  return { licenseId, user, end, replaced: previous?.id ?? null };
}
