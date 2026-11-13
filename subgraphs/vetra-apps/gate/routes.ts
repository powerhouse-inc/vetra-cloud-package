import type { AppsDeps } from "../service.js";
import { ADDRESS, checkGate } from "./check.js";
import { GateCounters, TokenBucket } from "./limit.js";
import { hashGateToken, isGateTokenShape } from "./token.js";

/** Token hashes verified recently: they skip the unknown-token bucket. Never answers. */
const VERIFIED_TTL_MS = 5 * 60_000;
const VERIFIED_MAX = 10_000;
const ANY = "*";

/**
 * Whom the unknown-token bucket is keyed by: the client address the nearest
 * proxy saw. The host runs behind the ingress with trustProxy on, and the
 * ingress appends the peer it saw as the last X-Forwarded-For entry, so that
 * entry is the one a client cannot write; entries before it are
 * client-supplied and ignored. X-Real-IP (also set by the ingress) is the
 * fallback, and with neither every caller shares one global key.
 */
export function gateClientKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  const last = xff?.split(",").pop()?.trim();
  if (last) return last;
  return request.headers.get("x-real-ip")?.trim() || ANY;
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

/**
 * POST apps/gate/check (releases phase 3 slice 5): a shared instance's host
 * asks with its VETRA_GATE_TOKEN whether `address` may in. The answer is
 * never cached here (G5).
 *
 * Rate limits (G6): a token whose hash was not verified in the last 5 minutes
 * takes from its client address's bucket before its lookup (a malformed one
 * too), so random tokens cost no database read once it is empty and one
 * flooding client never empties another's; a verified token gives its token
 * back. Every success refreshes the hash's 5 minutes (sliding), so a host
 * that keeps checking never falls back onto a bucket. A known instance has
 * its own bucket, keyed after the lookup so unverified input never fills
 * that map.
 */
export function createGateRoutes(
  deps: AppsDeps,
  opts: {
    perInstance?: TokenBucket;
    badTokens?: TokenBucket;
    counters?: GateCounters;
  } = {},
) {
  const perInstance = opts.perInstance ?? new TokenBucket(50, 500);
  const badTokens = opts.badTokens ?? new TokenBucket(20, 100);
  const counters = opts.counters ?? new GateCounters();
  const verified = new Map<string, number>();
  const isVerified = (hash: string) => {
    const until = verified.get(hash);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    verified.delete(hash);
    return false;
  };
  const remember = (hash: string) => {
    verified.delete(hash);
    verified.set(hash, Date.now() + VERIFIED_TTL_MS);
    while (verified.size > VERIFIED_MAX) {
      const oldest = verified.keys().next().value;
      if (oldest === undefined) break;
      verified.delete(oldest);
    }
  };
  const unauthorized = () => {
    counters.unauthorized();
    return json(401, {
      error: "UNAUTHENTICATED",
      message: "Invalid gate token",
    });
  };
  const limited = () => {
    counters.limited();
    return json(
      429,
      { error: "RATE_LIMITED", message: "Too many gate checks" },
      { "retry-after": "1" },
    );
  };
  return {
    counters,
    async check(request: Request): Promise<Response> {
      const m = /^Bearer\s+(\S+)$/i.exec(
        (request.headers.get("authorization") ?? "").trim(),
      );
      const token = m?.[1] ?? "";
      const client = gateClientKey(request);
      if (!isGateTokenShape(token))
        return badTokens.take(client) ? unauthorized() : limited();
      const hash = hashGateToken(token);
      const known = isVerified(hash);
      if (!known && !badTokens.take(client)) return limited();
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        if (!known) badTokens.refund(client);
        return json(400, {
          error: "BAD_USER_INPUT",
          message: "Body must be JSON",
        });
      }
      const address =
        body && typeof body === "object"
          ? (body as { address?: unknown }).address
          : undefined;
      if (typeof address !== "string" || !ADDRESS.test(address)) {
        if (!known) badTokens.refund(client);
        return json(400, {
          error: "BAD_USER_INPUT",
          message: "address must be a 0x address (40 hex digits)",
        });
      }
      try {
        const res = await checkGate(deps, token, address);
        if (!res) {
          verified.delete(hash);
          return unauthorized();
        }
        if (!known) badTokens.refund(client);
        remember(hash);
        if (!perInstance.take(res.instanceId)) return limited();
        counters.hit(res.instanceId, res.answer.allowed);
        return json(200, res.answer);
      } catch (err) {
        if (!known) badTokens.refund(client);
        counters.failed();
        // The error never carries the token (only its hash reaches the database).
        deps.logger.warn(
          `[vetra-apps] gate check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return json(503, {
          error: "SERVICE_UNAVAILABLE",
          message: "Try again",
        });
      }
    },
  };
}
