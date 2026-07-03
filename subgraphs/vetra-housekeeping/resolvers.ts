import type { StudioPowerStatus } from "./policy.js";
import type { StudioActivity } from "./keeper.js";

/** Subset of the reactor-api resolver context — mirrors vetra-access-codes. */
interface AuthContext {
  user?: { address: string; chainId: number; networkId: string };
  isAdmin?: (address: string) => boolean;
}

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
}

function requireAdmin(ctx: AuthContext): void {
  const address = ctx.user?.address?.toLowerCase();
  if (!address || !(ctx.isAdmin?.(address) ?? false)) {
    throw new Error("FORBIDDEN");
  }
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
