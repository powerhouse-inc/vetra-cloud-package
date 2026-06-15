interface AuthUser {
  address: string;
  networkId: string;
  chainId: string;
}
interface AuthContext {
  user?: AuthUser;
}

export interface ResolverDeps {
  /** Bound claimWarmEnvironment(deps, addr); addr is the lowercased caller address. */
  claim: (
    addr: string,
  ) => Promise<{ documentId: string; subdomain: string; tenantId: string } | null>;
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
        return deps.claim(ctx.user.address.toLowerCase());
      },
    },
  };
}
