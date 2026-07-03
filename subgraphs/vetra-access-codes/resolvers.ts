import { type Kysely } from "kysely";
import type { VetraAccessCodesDB } from "./db/schema.js";
import {
  createCode,
  getAccessStatus,
  getRedeemedKeyCiphertext,
  isCodeUsable,
  listCodes,
  listRedemptions,
  redeemCode,
  revokeAccess,
  setActiveCode,
  setCodeAnthropicKey,
  type AccessStatus,
  type InviteCodeView,
  type RedemptionView,
} from "./db/codes.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";

/**
 * OpenBao transit pseudo-tenant under which attached invite-code keys are
 * encrypted at rest. Distinct from any real tenant id, so the code keys get
 * their own transit key (`vetra-tenant-access-codes`).
 */
export const ACCESS_CODES_TRANSIT_TENANT = "access-codes";

export type ApplyInviteCodeSecretResult = {
  injected: boolean;
  secretNames: string[];
};

export interface ResolverDeps {
  /** Encrypts/decrypts attached keys at rest under the access-codes pseudo-tenant. */
  transit: OpenBaoTransitClient;
  /** Writes per-tenant secrets (the vetra-cloud-secrets service, in-process). */
  secretsService: SecretsService;
}

/**
 * Subset of the reactor-api resolver context this subgraph relies on. The
 * gateway verifies the Renown bearer token and populates `user`. Admin-ness is
 * checked against the deployment's `ADMINS` env (same source as reactor-api's
 * authorizationService.isSupremeAdmin) — the gateway does NOT inject an
 * `isAdmin` helper on the resolver context.
 */
type AuthContext = {
  user?: { address: string; chainId: number; networkId: string };
};

/** Canonical did:pkh for the authenticated caller, or null if unauthenticated. */
function callerDid(ctx: AuthContext): string | null {
  const u = ctx.user;
  if (!u) return null;
  return `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
}

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

export function createResolvers(
  db: Kysely<VetraAccessCodesDB>,
  deps: ResolverDeps,
): Record<string, any> {
  const { transit, secretsService } = deps;

  /** Encrypt a plaintext key for at-rest storage under the access-codes key. */
  async function encryptAttachedKey(plaintext: string): Promise<string> {
    await transit.ensureTenantKey(ACCESS_CODES_TRANSIT_TENANT);
    return transit.encrypt(ACCESS_CODES_TRANSIT_TENANT, plaintext);
  }

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

      applyInviteCodeSecret: async (
        _p: unknown,
        { tenantId, secretNames }: { tenantId: string; secretNames: string[] },
        ctx: AuthContext,
      ): Promise<ApplyInviteCodeSecretResult> => {
        const did = callerDid(ctx);
        if (!did) throw new Error("UNAUTHENTICATED");
        const ciphertext = await getRedeemedKeyCiphertext(db, did);
        if (ciphertext === null) return { injected: false, secretNames: [] };
        const apiKey = await transit.decrypt(
          ACCESS_CODES_TRANSIT_TENANT,
          ciphertext,
        );
        // Sequential: setSecret pg_notifies the reconciler per write; a handful
        // of studio secret names, so no need to parallelize.
        for (const name of secretNames) {
          await secretsService.setSecret(tenantId, name, apiKey);
        }
        return { injected: true, secretNames };
      },

      createInviteCode: async (
        _p: unknown,
        args: {
          code: string;
          label?: string | null;
          expiresAt?: string | null;
          maxUses?: number | null;
          anthropicApiKey?: string | null;
        },
        ctx: AuthContext,
      ): Promise<InviteCodeView> => {
        requireAdmin(ctx);
        const anthropicKeyCiphertext = args.anthropicApiKey
          ? await encryptAttachedKey(args.anthropicApiKey)
          : null;
        return createCode(db, {
          code: args.code,
          label: args.label ?? null,
          expiresAt: args.expiresAt ?? null,
          maxUses: args.maxUses ?? null,
          anthropicKeyCiphertext,
        });
      },

      setInviteCodeAnthropicKey: async (
        _p: unknown,
        { code, anthropicApiKey }: { code: string; anthropicApiKey?: string | null },
        ctx: AuthContext,
      ): Promise<InviteCodeView> => {
        requireAdmin(ctx);
        const ciphertext = anthropicApiKey
          ? await encryptAttachedKey(anthropicApiKey)
          : null;
        const view = await setCodeAnthropicKey(db, code, ciphertext);
        if (!view) throw new Error("CODE_NOT_FOUND");
        return view;
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
