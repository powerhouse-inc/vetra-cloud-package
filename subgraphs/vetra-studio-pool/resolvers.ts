interface AuthUser {
  address: string;
  networkId: string;
  chainId: string;
}
interface AuthContext {
  user?: AuthUser;
}

export interface ResolverDeps {
  /** Bound claimWarmEnvironment(deps, did); `did` is the caller's did:pkh identifier. */
  claim: (
    did: string,
  ) => Promise<{ documentId: string; subdomain: string; tenantId: string } | null>;
}

/** Mirror vetra-access-codes `callerDid` so the attached-key lookup matches the redemption. */
function callerDid(u: AuthUser): string {
  return `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
}

export function createResolvers(deps: ResolverDeps): Record<string, any> {
  return {
    Mutation: {
      VetraStudioPool: () => ({}),
    },
    VetraStudioPoolMutations: {
      claimStudioEnvironment: async (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ) => {
        if (!ctx.user) throw new Error("UNAUTHENTICATED");
        return deps.claim(callerDid(ctx.user));
      },
    },
  };
}
