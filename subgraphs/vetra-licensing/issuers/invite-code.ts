import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../db/schema.js";
import { normaliseUserDid } from "../did.js";
import { AlreadyHoldsError, issueLicense, type IssueDeps } from "../issue.js";
import {
  InvalidCodeError,
  attachLicence,
  findRedemption,
  getCode,
  isUsable,
  releaseReservation,
  reserveRedemption,
} from "../invite-codes.js";
import { resolveKind } from "../app-reads.js";
import { keyedMutex } from "../keyed-mutex.js";
import type { LicenceRecord } from "../reads.js";

export interface InviteCodeIssuerDeps extends IssueDeps {
  db: Kysely<VetraLicensingDB>;
  /** The caller's ACTIVE, authorised licences of one app. */
  activeLicencesOf(appId: string, userDid: string): Promise<LicenceRecord[]>;
}

/**
 * One redeem per (app, holder) at a time, in this process (production runs a
 * single replica): a double-submitted redeem sees the first one's licence
 * instead of issuing a second, and two codes for one SHARED kind cannot both
 * pass the ALREADY_HOLDS check. The startup migration takes the same key
 * (`<appId>\0<holder DID>`) while it builds a holder's studio licence.
 */
export const withHolderLock = keyedMutex();

/** The invite code an INVITE_CODE licence was issued from (its `details.code`). */
function codeOf(l: LicenceRecord): string | null {
  if (!l.details) return null;
  try {
    const d: unknown = JSON.parse(l.details);
    if (d === null || typeof d !== "object") return null;
    const code = (d as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** Codes are redeemable secrets: logs carry a short sha256 prefix, never the code. */
export function codeRef(code: string): string {
  return `code#${createHash("sha256").update(code).digest("hex").slice(0, 12)}`;
}

/** The ACTIVE, authorised licence this code already issued to the holder, if any. */
async function licenceIssuedBy(
  deps: InviteCodeIssuerDeps,
  row: { app_id: string; kind: string; code: string },
  user: string,
): Promise<LicenceRecord | undefined> {
  return (await deps.activeLicencesOf(row.app_id, user)).find(
    (l) => l.issuer === "INVITE_CODE" && l.kind === row.kind && codeOf(l) === row.code,
  );
}

/** Gives the use back; a failure is logged, never masks the error being reported. */
async function release(deps: InviteCodeIssuerDeps, code: string, user: string): Promise<void> {
  try {
    await releaseReservation(deps.db, code, user);
  } catch (err) {
    deps.logger.warn(
      `[licensing] could not release the reservation of ${codeRef(code)} for ${user}; a retry completes it: ${String(err)}`,
    );
  }
}

/**
 * InviteCodeIssuer. Reserve the use first (the cap is enforced under a row
 * lock), then issue; a failed issue gives the use back. Re-redeeming a code
 * you already redeemed returns the licence you got, which is also what makes
 * a crashed redeem safe to retry:
 * - crashed before the licence was issued: the reservation is completed;
 * - crashed after it was issued but before it was attached: the licence is
 *   found among the holder's ACTIVE licences (issued by this code, for its
 *   kind) and attached, instead of issuing a second one.
 */
export async function redeemInviteCode(
  deps: InviteCodeIssuerDeps,
  input: { code: string; user: string; label: string | null; upgrades: string | null; now: string },
): Promise<{ licenseId: string; appId: string; fresh: boolean }> {
  const user = normaliseUserDid(input.user);
  const row = await getCode(deps.db, input.code);
  if (!row) throw new InvalidCodeError();
  const code = row.code;
  const appId = row.app_id;

  return withHolderLock(`${appId}\u0000${user}`, async () => {
    const existing = await findRedemption(deps.db, code, user);
    if (existing?.license_id) return { licenseId: existing.license_id, appId, fresh: false };

    if (existing) {
      const issued = await licenceIssuedBy(deps, row, user);
      if (issued) {
        await attachLicence(deps.db, code, user, issued.id, issued.end);
        return { licenseId: issued.id, appId, fresh: false };
      }
    } else if (!(await isUsable(deps.db, row, input.now))) {
      // Before anything else can answer: an unusable code reveals nothing
      // about itself (not even its kind's mode) to someone who never redeemed
      // it. reserveRedemption re-checks under the row lock.
      throw new InvalidCodeError();
    }

    // A SHARED term grants one thing: an account on one environment. Holding
    // it twice is meaningless, so a second code for it is refused (contract
    // ALREADY_HOLDS), also when completing a reservation. A DEDICATED term may
    // be held many times: one environment per licence chain ("buy another for
    // a different project"). An upgrade is checked by issueLicense against the
    // licence it replaces.
    if (!input.upgrades) {
      const app = await deps.apps.app(appId);
      const resolved = app ? resolveKind(app, row.kind) : null;
      if (resolved?.ok && resolved.template.mode === "SHARED") {
        const held = await deps.activeLicencesOf(appId, user);
        if (held.some((l) => l.kind === row.kind)) {
          if (existing) await release(deps, code, user);
          throw new AlreadyHoldsError(`you already hold ${row.kind}`);
        }
      }
    }
    if (!existing && !(await reserveRedemption(deps.db, code, user, input.now))) {
      // Exhausted under the lock, or another redeem of this holder (another
      // replica) reserved first: hand back its licence if it has one.
      const raced = await findRedemption(deps.db, code, user);
      if (raced?.license_id) return { licenseId: raced.license_id, appId, fresh: false };
      throw new InvalidCodeError();
    }

    let issued;
    try {
      issued = await issueLicense(deps, {
        appId,
        user,
        kind: row.kind,
        issuer: "INVITE_CODE",
        details: { code },
        issuedBy: user,
        label: input.label,
        upgrades: input.upgrades,
        now: input.now,
      });
    } catch (err) {
      // A licence this code issued to the holder may exist despite the error:
      // keep the use and attach it. Otherwise nothing was authorised: give the
      // use back so the cap is not consumed.
      let issuedAnyway: LicenceRecord | undefined;
      try {
        issuedAnyway = await licenceIssuedBy(deps, row, user);
      } catch (lookupErr) {
        deps.logger.warn(
          `[licensing] redeem of ${codeRef(code)} for ${user} failed and its licence could not be looked up: ${String(lookupErr)}`,
        );
      }
      if (issuedAnyway) {
        await attachLicence(deps.db, code, user, issuedAnyway.id, issuedAnyway.end);
        return { licenseId: issuedAnyway.id, appId, fresh: true };
      }
      await release(deps, code, user);
      throw err;
    }
    // Not released if this fails: the licence exists, and a retry finds and
    // attaches it (above).
    await attachLicence(deps.db, code, user, issued.licenseId, issued.end);
    return { licenseId: issued.licenseId, appId, fresh: true };
  });
}
