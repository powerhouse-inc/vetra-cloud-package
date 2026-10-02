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
  /** GitHub event that started the run (push, pull_request, …). */
  eventName?: string;
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

/** Parse a `vetra` claim object from a (verified) token payload. */
export function parseVetraClaim(vetra: unknown): VetraClaim | null {
  if (!vetra || typeof vetra !== "object") return null;
  const claim = vetra as Record<string, unknown>;
  if (typeof claim.ref !== "string" || !claim.ref) return null;
  const str = (v: unknown) =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  return {
    ref: claim.ref,
    refClass: str(claim.refClass),
    eventName: str(claim.eventName),
    sha: str(claim.sha),
    repository: str(claim.repository),
    repositoryId: str(claim.repositoryId),
    runId: str(claim.runId),
    runAttempt: str(claim.runAttempt),
    actor: str(claim.actor),
    prNumber: typeof claim.prNumber === "number" ? claim.prNumber : null,
  };
}

/** Payload of a compact JWT (no verification), or null. */
export function decodeJwtPayloadUnverified(
  token: string,
): Record<string, unknown> | null {
  return decodeJwtPayload(token);
}

/**
 * Does the request's bearer carry a `vetra` claim (i.e. is it a CI workload
 * token)? Those are only accepted by the vetra-apps HTTP routes, never by
 * GraphQL — checked without verification on purpose: any such token is refused.
 */
export function bearerHasVetraClaim(ctx: AppsContext): boolean {
  const raw = ctx.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match) return false;
  const payload = decodeJwtPayload(match[1]);
  return !!payload && payload.vetra !== undefined && payload.vetra !== null;
}
