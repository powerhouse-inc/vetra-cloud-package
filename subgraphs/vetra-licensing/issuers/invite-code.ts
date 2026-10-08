import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../db/schema.js";
import { normaliseUserDid } from "../did.js";
import { AlreadyHoldsError, issueLicense, type IssueDeps } from "../issue.js";
import {
  InvalidCodeError,
  attachLicence,
  findRedemption,
  getCode,
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
 * pass the ALREADY_HOLDS check.
 */
const withHolderLock = keyedMutex();

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

/** Gives the use back; a failure is logged, never masks the error being reported. */
async function release(deps: InviteCodeIssuerDeps, code: string, user: string): Promise<void> {
  try {
    await releaseReservation(deps.db, code, user);
  } catch (err) {
    deps.logger.warn(
      `[licensing] could not release the reservation of ${code} for ${user}; a retry completes it: ${String(err)}`,
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
      const issued = (await deps.activeLicencesOf(appId, user)).find(
        (l) => l.issuer === "INVITE_CODE" && l.kind === row.kind && codeOf(l) === code,
      );
      if (issued) {
        await attachLicence(deps.db, code, user, issued.id, issued.end);
        return { licenseId: issued.id, appId, fresh: false };
      }
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
      // Nothing was authorised: give the use back so the cap is not consumed.
      await release(deps, code, user);
      throw err;
    }
    // Not released if this fails: the licence exists, and a retry finds and
    // attaches it (above).
    await attachLicence(deps.db, code, user, issued.licenseId, issued.end);
    return { licenseId: issued.licenseId, appId, fresh: true };
  });
}
