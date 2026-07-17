import { timingSafeEqual } from "node:crypto";
import type { StudioPowerStatus } from "./policy.js";
import type { StudioActivity } from "./keeper.js";

/**
 * Subset of the reactor-api resolver context — mirrors vetra-access-codes.
 *
 * `headers` is the real reactor-api `Context.headers` (IncomingHttpHeaders):
 * unlike `user` (populated by the gateway's own bearer-verification, and
 * `additionalContextFields`, which is a static/global merge — neither is a
 * per-subgraph, per-request hook), raw request headers ARE forwarded to every
 * resolver call as-is. `internalKey` is the resolved `x-housekeeping-key`
 * value; resolvers read it via `resolveInternalKey` below, which prefers an
 * already-set `ctx.internalKey` (what the unit tests provide) and otherwise
 * derives it from `ctx.headers`.
 */
interface AuthContext {
  user?: { address: string; chainId: number; networkId: string };
  internalKey?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** Every raw field the external idle detector needs to run eligibility itself. */
export type StudioCandidate = {
  host: string;
  subdomain: string | null;
  envId: string;
  owner: string | null;
  status: string;
  poolState: string | null;
  tenantId: string | null;
  /** JSON string of the env's services, as stored (read-model `environments.services`). */
  services: string | null;
};

export type StudioPowerStateResult = {
  host: string;
  envId: string | null;
  subdomain: string | null;
  owner: string | null;
  status: StudioPowerStatus;
};

export interface HousekeepingDeps {
  /** Read-only: resolve a host to its current power state. */
  powerState: (host: string) => Promise<StudioPowerStateResult>;
  /** Put an eligible studio to sleep (idempotent). */
  sleep: (host: string) => Promise<StudioPowerStateResult>;
  /** Wake a sleeping studio (idempotent; no-op if already awake/waking). */
  wake: (host: string) => Promise<StudioPowerStateResult>;
  /** Read-only: classify every claimed READY studio (idle detector's view). */
  studioActivity: () => Promise<StudioActivity[]>;
  /** Read-only: raw claimed-READY candidate rows for an external detector to run eligibility itself. */
  readyStudios: () => Promise<StudioCandidate[]>;
}

/**
 * Admin gate. reactor-api verifies the Renown bearer and populates `ctx.user`,
 * but does NOT inject a `ctx.isAdmin` helper into subgraph resolver context — it
 * checks admin-ness via `authorizationService.isSupremeAdmin`, which compares the
 * caller against the `ADMINS` env. We do the same (the old `ctx.isAdmin?.()` was
 * always undefined → FORBIDDEN for everyone, even valid admins).
 */
function requireAdmin(ctx: AuthContext): void {
  const address = ctx.user?.address?.toLowerCase();
  const admins = (process.env.ADMINS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (!address || !admins.includes(address)) {
    throw new Error("FORBIDDEN");
  }
}

/** Constant-time string compare, guarded against length mismatch (which `timingSafeEqual` throws on). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Prefer an already-resolved `ctx.internalKey` (unit tests); else read the raw request header. */
function resolveInternalKey(ctx: AuthContext): string | undefined {
  if (typeof ctx.internalKey === "string") return ctx.internalKey;
  const raw = ctx.headers?.["x-housekeeping-key"];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Gate for the external-detector surface: passes if the caller presents the
 * shared `HOUSEKEEPING_INTERNAL_KEY` (constant-time compare, non-empty on both
 * sides) OR is an admin (`requireAdmin`). Used by `readyStudios` here; Task 1.2
 * reuses this same helper for `sleepStudio`.
 */
function requireInternalOrAdmin(ctx: AuthContext): void {
  const expected = process.env.HOUSEKEEPING_INTERNAL_KEY ?? "";
  const provided = resolveInternalKey(ctx) ?? "";
  if (expected.length > 0 && provided.length > 0 && safeEqual(provided, expected)) {
    return;
  }
  requireAdmin(ctx);
}

export function createResolvers(deps: HousekeepingDeps): Record<string, any> {
  return {
    Query: {
      VetraHousekeeping: () => ({}),
    },
    VetraHousekeepingQueries: {
      studioPowerState: (
        _p: unknown,
        args: { host: string },
      ) => deps.powerState(args.host),
      // Read-only ops view of the idle detector — admin only (exposes owners/hosts).
      studioActivity: (_p: unknown, _a: unknown, ctx: AuthContext) => {
        requireAdmin(ctx);
        return deps.studioActivity();
      },
      // Raw candidate rows for an external idle detector — internal-service key or admin.
      // async: a synchronous throw here would reject the *call* itself rather than
      // the returned promise, breaking `await expect(...).rejects.toThrow(...)`.
      readyStudios: async (_p: unknown, _a: unknown, ctx: AuthContext) => {
        requireInternalOrAdmin(ctx);
        return deps.readyStudios();
      },
    },
    Mutation: {
      VetraHousekeeping: () => ({}),
    },
    VetraHousekeepingMutations: {
      // Manual "sleep now" — admin only.
      sleepStudio: (_p: unknown, args: { host: string }, ctx: AuthContext) => {
        requireAdmin(ctx);
        return deps.sleep(args.host);
      },
      // Open + idempotent: waking is inherently triggered by "someone wants this
      // studio" (the activator calls this for any visitor to a sleeping host),
      // and it only ever wakes a STOPPED env — so it needs no admin token, which
      // is what lets the long-running activator call it without an expiring
      // credential. Worst case is a wasted wake that re-sleeps within the window.
      wakeStudio: (_p: unknown, args: { host: string }) => deps.wake(args.host),
    },
  };
}
