import type { StudioPowerStatus } from "./policy.js";

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
    },
    Mutation: {
      VetraHousekeeping: () => ({}),
    },
    VetraHousekeepingMutations: {
      sleepStudio: (_p: unknown, args: { host: string }, ctx: AuthContext) => {
        requireAdmin(ctx);
        return deps.sleep(args.host);
      },
      wakeStudio: (_p: unknown, args: { host: string }, ctx: AuthContext) => {
        requireAdmin(ctx);
        return deps.wake(args.host);
      },
    },
  };
}
