import { UnsupportedDidError, normaliseUserDid } from "./did.js";
import type { KeyVault } from "./key-vault.js";
import type { AuthorisedLicence } from "./licence-view.js";

/**
 * The vetra-studio gate (replaces vetra-access-codes' getAccessStatus and
 * getRedeemedKeyCiphertext). Everything is decided from DB authority: the
 * holder's licences come from grant rows with the recorded lifecycle status
 * and end, and a licence's Claude key from the code its holder redeemed for it
 * (invite_redemptions), never from the licence document.
 */
export interface StudioAccessDeps {
  /** The studio app's id (the fixed STUDIO_APP_ID), null while its document does not exist. */
  studioAppId(): Promise<string | null>;
  /** The holder's licences of one app, grant-sourced with lifecycle overlaid, oldest first. */
  licencesOf(appId: string, userDid: string): Promise<AuthorisedLicence[]>;
  /** The code the holder redeemed for this licence; null when it was not redeemed by them. */
  redeemedCode(licenseId: string, userDid: string): Promise<string | null>;
  keyCiphertextForCode(code: string): Promise<string | null>;
  /** Null when OPENBAO_ADDR is unset: attached keys cannot be read. */
  keyVault: KeyVault | null;
  now(): string;
}

export interface StudioAccess {
  allowed: boolean;
  licenseId: string | null;
  expires: string | null;
  hasAttachedKey: boolean;
}

interface Held {
  all: AuthorisedLicence[];
  /** ACTIVE and not past their end, the longest-lasting first (no end = forever). */
  usable: AuthorisedLicence[];
}

const endMs = (l: AuthorisedLicence) => {
  const ms = l.end === null ? Number.POSITIVE_INFINITY : Date.parse(l.end);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

async function held(deps: StudioAccessDeps, did: string): Promise<Held> {
  const appId = await deps.studioAppId();
  if (!appId) return { all: [], usable: [] };
  const all = await deps.licencesOf(appId, did);
  const now = Date.parse(deps.now());
  const usable = all
    .filter((l) => l.status === "ACTIVE" && endMs(l) > now)
    .sort((a, b) => endMs(b) - endMs(a));
  return { all, usable };
}

/**
 * The key behind a usable licence: its own redeemed code's, else one of its
 * chain predecessors' (a renewal through a code without a key keeps the key
 * the chain started with). A licence that is no longer live and no longer in
 * a live chain never lends its key.
 */
async function keyCiphertext(deps: StudioAccessDeps, did: string, h: Held): Promise<string | null> {
  const predecessorOf = new Map(
    h.all.flatMap((l) => (l.replacedBy ? [[l.replacedBy, l] as const] : [])),
  );
  for (const live of h.usable) {
    const seen = new Set<string>();
    for (let l: AuthorisedLicence | undefined = live; l && !seen.has(l.id); l = predecessorOf.get(l.id)) {
      seen.add(l.id);
      const code = await deps.redeemedCode(l.id, did);
      const ct = code ? await deps.keyCiphertextForCode(code) : null;
      if (ct) return ct;
    }
  }
  return null;
}

const DENIED: StudioAccess = { allowed: false, licenseId: null, expires: null, hasAttachedKey: false };

/** The holder's one spelling (chain normalised away); null for a DID that is no EVM wallet. */
function holderOf(did: string): string | null {
  try {
    return normaliseUserDid(did);
  } catch (err) {
    if (err instanceof UnsupportedDidError) return null;
    throw err;
  }
}

/**
 * Whether the caller may use Vetra Studio. `licenseId` and `expires` name the
 * longest-lasting usable licence; when there is none, the caller's newest
 * studio licence (by grant row), so the client can show its offboarding
 * warnings. Both are null only for someone who never held a studio licence.
 * `hasAttachedKey` is true only when applyStudioKey could deliver a key.
 */
export async function studioAccess(deps: StudioAccessDeps, rawDid: string): Promise<StudioAccess> {
  const did = holderOf(rawDid);
  if (did === null) return DENIED;
  const h = await held(deps, did);
  const best = h.usable.at(0);
  if (best) {
    const key = deps.keyVault ? await keyCiphertext(deps, did, h) : null;
    return { allowed: true, licenseId: best.id, expires: best.end, hasAttachedKey: key !== null };
  }
  const newest = h.all.at(-1);
  return { allowed: false, licenseId: newest?.id ?? null, expires: newest?.end ?? null, hasAttachedKey: false };
}

/** The Claude key behind the caller's usable studio licence, decrypted; null when there is none. */
export async function studioKeyForDid(deps: StudioAccessDeps, rawDid: string): Promise<string | null> {
  const did = holderOf(rawDid);
  if (did === null || !deps.keyVault) return null;
  const ct = await keyCiphertext(deps, did, await held(deps, did));
  return ct === null ? null : deps.keyVault.decrypt(ct);
}
