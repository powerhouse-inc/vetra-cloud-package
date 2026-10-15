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
  /** The monthly LLM budget (USD) set on a code, null when unset. Absent: no code carries a budget. */
  llmBudgetForCode?(code: string): Promise<number | null>;
  /** VETRA_LLM_DEFAULT_BUDGET_USD: the budget when no code in the chain sets one. Absent: 0. */
  defaultLlmBudgetUsd?: number;
  /** Null when OPENBAO_ADDR is unset: attached keys cannot be read. */
  keyVault: KeyVault | null;
  now(): string;
}

export interface StudioAccess {
  allowed: boolean;
  licenseId: string | null;
  expires: string | null;
  hasAttachedKey: boolean;
  llmBudgetUsd: number;
}

/** What the vetra-llm broker provisions for a holder: a key only when allowed and budgetUsd > 0. */
export interface StudioLlmBudget {
  allowed: boolean;
  budgetUsd: number;
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
 * Each usable licence, longest-lasting first, then its chain predecessors (a
 * renewal through a code without a key or budget keeps what the chain started
 * with). A licence that is no longer live and no longer in a live chain never
 * appears.
 */
function* chainLicences(h: Held): Generator<AuthorisedLicence> {
  const predecessorOf = new Map(
    h.all.flatMap((l) => (l.replacedBy ? [[l.replacedBy, l] as const] : [])),
  );
  for (const live of h.usable) {
    const seen = new Set<string>();
    for (let l: AuthorisedLicence | undefined = live; l && !seen.has(l.id); l = predecessorOf.get(l.id)) {
      seen.add(l.id);
      yield l;
    }
  }
}

/** The key behind a usable licence: its own redeemed code's, else one of its chain predecessors'. */
async function keyCiphertext(deps: StudioAccessDeps, did: string, h: Held): Promise<string | null> {
  for (const l of chainLicences(h)) {
    const code = await deps.redeemedCode(l.id, did);
    const ct = code ? await deps.keyCiphertextForCode(code) : null;
    if (ct) return ct;
  }
  return null;
}

/** The monthly LLM budget of usable licences: the first code along the chain that sets one, else the default. */
async function llmBudget(deps: StudioAccessDeps, did: string, h: Held): Promise<number> {
  if (deps.llmBudgetForCode) {
    for (const l of chainLicences(h)) {
      const code = await deps.redeemedCode(l.id, did);
      const budget = code ? await deps.llmBudgetForCode(code) : null;
      if (budget !== null) return budget;
    }
  }
  return deps.defaultLlmBudgetUsd ?? 0;
}

const DENIED: StudioAccess = { allowed: false, licenseId: null, expires: null, hasAttachedKey: false, llmBudgetUsd: 0 };

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
    return { allowed: true, licenseId: best.id, expires: best.end, hasAttachedKey: key !== null, llmBudgetUsd: await llmBudget(deps, did, h) };
  }
  const newest = h.all.at(-1);
  return { allowed: false, licenseId: newest?.id ?? null, expires: newest?.end ?? null, hasAttachedKey: false, llmBudgetUsd: 0 };
}

/** The Claude key behind the caller's usable studio licence, decrypted; null when there is none. */
export async function studioKeyForDid(deps: StudioAccessDeps, rawDid: string): Promise<string | null> {
  const did = holderOf(rawDid);
  if (did === null || !deps.keyVault) return null;
  const ct = await keyCiphertext(deps, did, await held(deps, did));
  return ct === null ? null : deps.keyVault.decrypt(ct);
}

/** The monthly LLM budget for a holder's Studio: allowed only with a usable studio licence. */
export async function studioLlmBudgetForDid(deps: StudioAccessDeps, rawDid: string): Promise<StudioLlmBudget> {
  const did = holderOf(rawDid);
  if (did === null) return { allowed: false, budgetUsd: 0 };
  const h = await held(deps, did);
  if (h.usable.length === 0) return { allowed: false, budgetUsd: 0 };
  return { allowed: true, budgetUsd: await llmBudget(deps, did, h) };
}
