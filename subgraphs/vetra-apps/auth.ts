import { callerIsAdmin } from "../../shared/admins.js";
import { appsError } from "./errors.js";

/** Subset of the reactor-api resolver context used here. */
export interface AppsContext {
  user?: {
    address: string;
    chainId: number;
    networkId: string;
    appKey?: string;
  };
  headers?: Record<string, string | string[] | undefined>;
  isAdmin?: (address: string) => boolean;
}

/**
 * The `vetra` claim a Renown workload token carries (contract C1): which CI
 * run, ref and repository the App identity's token was minted for.
 */
export interface VetraClaim {
  ref: string;
  refClass?: string;
  sha?: string;
  repository?: string;
  repositoryId?: string;
  runId?: string;
  runAttempt?: string;
  actor?: string;
  prNumber?: number | null;
}

export interface Caller {
  address: string;
  chainId: number;
  appKey: string | null;
  isAdmin: boolean;
}

export function requireCaller(ctx: AppsContext): Caller {
  const address = ctx.user?.address?.toLowerCase();
  if (!address) throw appsError("UNAUTHENTICATED", "Sign in with Renown");
  return {
    address,
    chainId: ctx.user?.chainId ?? 1,
    appKey: ctx.user?.appKey ?? null,
    isAdmin: callerIsAdmin(ctx, address),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `vetra` claim of the request's bearer. The gateway already verified the
 * token's signature (that is how `ctx.user` exists), so the payload is only
 * re-read here — and only trusted when its issuer is the same did:key the
 * gateway put into `ctx.user.appKey`, i.e. it is the very token that
 * authenticated this request. Anything else → null (no claim).
 */
export function readVetraClaim(ctx: AppsContext): VetraClaim | null {
  const raw = ctx.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const payload = decodeJwtPayload(match[1]);
  if (!payload) return null;
  const appKey = ctx.user?.appKey;
  if (!appKey || (payload.iss !== appKey && payload.sub !== appKey))
    return null;
  const vetra = payload.vetra;
  if (!vetra || typeof vetra !== "object") return null;
  const claim = vetra as Record<string, unknown>;
  if (typeof claim.ref !== "string" || !claim.ref) return null;
  const str = (v: unknown) =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  return {
    ref: claim.ref,
    refClass: str(claim.refClass),
    sha: str(claim.sha),
    repository: str(claim.repository),
    repositoryId: str(claim.repositoryId),
    runId: str(claim.runId),
    runAttempt: str(claim.runAttempt),
    actor: str(claim.actor),
    prNumber: typeof claim.prNumber === "number" ? claim.prNumber : null,
  };
}
