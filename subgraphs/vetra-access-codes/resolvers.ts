import { type Kysely } from "kysely";
import type { VetraAccessCodesDB } from "./db/schema.js";
import {
  createCode,
  getAccessStatus,
  isCodeUsable,
  listCodes,
  listRedemptions,
  redeemCode,
  revokeAccess,
  setActiveCode,
  type AccessStatus,
  type InviteCodeView,
  type RedemptionView,
} from "./db/codes.js";

/**
 * Subset of the reactor-api resolver context this subgraph relies on. The
 * gateway verifies the Renown bearer token and populates `user`; `isAdmin`
 * checks the address against the deployment's admin allowlist (ADMINS env).
 */
type AuthContext = {
  user?: { address: string; chainId: number; networkId: string };
  isAdmin?: (address: string) => boolean;
};

/** Canonical did:pkh for the authenticated caller, or null if unauthenticated. */
function callerDid(ctx: AuthContext): string | null {
  const u = ctx.user;
  if (!u) return null;
  return `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
}

function requireAdmin(ctx: AuthContext): void {
  const address = ctx.user?.address?.toLowerCase();
  if (!address || !(ctx.isAdmin?.(address) ?? false)) {
    throw new Error("FORBIDDEN");
  }
}

export function createResolvers(
  db: Kysely<VetraAccessCodesDB>,
): Record<string, any> {
  return {
    Query: {
      VetraAccessCodes: () => ({}),
    },
    Mutation: {
      VetraAccessCodes: () => ({}),
    },

    VetraAccessCodesQueries: {
      inviteCodeValid: (_p: unknown, { code }: { code: string }) =>
        isCodeUsable(db, code),

      myAccessStatus: (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ): Promise<AccessStatus> => {
        const did = callerDid(ctx);
        if (!did) throw new Error("UNAUTHENTICATED");
        return getAccessStatus(db, did);
      },

      inviteCodes: (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ): Promise<InviteCodeView[]> => {
        requireAdmin(ctx);
        return listCodes(db);
      },

      redemptions: (
        _p: unknown,
        { code, address }: { code?: string | null; address?: string | null },
        ctx: AuthContext,
      ): Promise<RedemptionView[]> => {
        requireAdmin(ctx);
        return listRedemptions(db, { code, address });
      },
    },

    VetraAccessCodesMutations: {
      redeemInviteCode: async (
        _p: unknown,
        { code }: { code: string },
        ctx: AuthContext,
      ): Promise<AccessStatus> => {
        const did = callerDid(ctx);
        if (!did) throw new Error("UNAUTHENTICATED");
        const result = await redeemCode(db, code, did);
        if (!result.ok) throw new Error("INVALID_CODE");
        return getAccessStatus(db, did);
      },

      createInviteCode: (
        _p: unknown,
        args: {
          code: string;
          label?: string | null;
          expiresAt?: string | null;
          maxUses?: number | null;
        },
        ctx: AuthContext,
      ): Promise<InviteCodeView> => {
        requireAdmin(ctx);
        return createCode(db, {
          code: args.code,
          label: args.label ?? null,
          expiresAt: args.expiresAt ?? null,
          maxUses: args.maxUses ?? null,
        });
      },

      setInviteCodeActive: async (
        _p: unknown,
        { code, active }: { code: string; active: boolean },
        ctx: AuthContext,
      ): Promise<InviteCodeView> => {
        requireAdmin(ctx);
        const view = await setActiveCode(db, code, active);
        if (!view) throw new Error("CODE_NOT_FOUND");
        return view;
      },

      revokeAccess: (
        _p: unknown,
        { address }: { address: string },
        ctx: AuthContext,
      ): Promise<number> => {
        requireAdmin(ctx);
        return revokeAccess(db, address);
      },
    },
  };
}
