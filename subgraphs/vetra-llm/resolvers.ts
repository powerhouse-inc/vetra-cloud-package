import { randomBytes } from "node:crypto";
import { callerIsAdmin } from "../../shared/admins.js";
import { isStudioState } from "../../shared/studio-package.js";
import type { TenantOwnersResult } from "../../shared/tenant-owners.js";
import type {
  EnvAccess,
  EnvAccessRow,
} from "../vetra-cloud-observability/env-access.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import { didForAddress } from "../vetra-licensing/did.js";
import { OPENROUTER_KEY_SECRET, type LlmBroker } from "./broker.js";
import { llmError, notConfigured, toLlmGraphQLError } from "./errors.js";

const SESSION_EXPORT_SECRET = "VETRA_SESSION_EXPORT_SECRET";

export interface LlmContext {
  user?: { address?: string };
  isAdmin?: (address: string) => boolean;
}

export interface LlmResolverDeps {
  broker: LlmBroker;
  tenantOwners(tenantId: string): Promise<TenantOwnersResult>;
  /** Environment ids projected for a tenant. */
  envIdsByTenant(tenantId: string): Promise<string[]>;
  /** The projection row access is decided on; null when unknown. */
  envRow(
    environmentId: string,
  ): Promise<(EnvAccessRow & { tenantId: string | null }) | null>;
  /** The environment document's state (the truth for "is this a Studio"). */
  envState(
    environmentId: string,
  ): Promise<{ packages: ReadonlyArray<{ name: string }> } | null>;
  access: EnvAccess;
  secrets: Pick<SecretsService, "setSecret" | "listSecretKeys"> | null;
  logger: Pick<Console, "info" | "warn" | "error">;
}

interface Caller {
  address: string;
  did: string;
  isAdmin: boolean;
}

function requireCaller(ctx: LlmContext): Caller {
  const address = ctx.user?.address?.toLowerCase();
  if (!address) throw llmError("UNAUTHENTICATED", "Sign in with Renown");
  return {
    address,
    did: didForAddress(address),
    isAdmin: callerIsAdmin(ctx, address),
  };
}

export function createLlmResolvers(
  deps: LlmResolverDeps,
): Record<string, unknown> {
  const wrap =
    <A, R>(fn: (a: A, ctx: LlmContext) => Promise<R>) =>
    async (_p: unknown, a: A, ctx: LlmContext): Promise<R> => {
      try {
        return await fn(a, ctx);
      } catch (err) {
        throw toLlmGraphQLError(err, deps.logger);
      }
    };

  /** The caller must operate the env (canOperate), and it must be a Studio. */
  const operable = async (environmentId: string, ctx: LlmContext) => {
    const caller = requireCaller(ctx);
    const env = await deps.envRow(environmentId);
    if (!env) throw llmError("NOT_FOUND", "environment not found");
    if (!(await deps.access.canOperate(caller, env))) {
      throw llmError("FORBIDDEN", "you cannot operate this environment");
    }
    if (!isStudioState(await deps.envState(environmentId))) {
      throw llmError("BAD_USER_INPUT", "not a Vetra Studio");
    }
    return { caller, env };
  };

  return {
    Query: { vetraLlm: () => ({}) },
    Mutation: { vetraLlm: () => ({}) },

    VetraLlmQueries: {
      studioLlmStatus: wrap(async (a: { environmentId: string }, ctx) => {
        const { env } = await operable(a.environmentId, ctx);
        if (!deps.secrets || !env.tenantId)
          return { environmentId: a.environmentId, connected: false };
        const keys = await deps.secrets.listSecretKeys(env.tenantId);
        return {
          environmentId: a.environmentId,
          connected: keys.some((k) => k.key === OPENROUTER_KEY_SECRET),
        };
      }),

      studioLlmUsage: wrap(async (a: { environmentId: string }, ctx) => {
        await operable(a.environmentId, ctx);
        return deps.broker.studioLlmUsage(a.environmentId);
      }),
    },

    VetraLlmMutations: {
      provisionStudioLlm: wrap(async (a: { tenantId: string }, ctx) => {
        const caller = requireCaller(ctx);
        // Same check as licensing's applyStudioKey: every environment on the
        // tenant must be the caller's (subscriptions-resolvers.ts).
        const r = await deps.tenantOwners(a.tenantId);
        if (!r.ok) {
          if (r.reason === "UNKNOWN")
            throw llmError("NOT_FOUND", "unknown tenant");
          throw llmError(
            "FORBIDDEN",
            r.reason === "BUSY"
              ? "too many tenants are being waited on; retry shortly"
              : "tenant ownership cannot be verified in this deployment",
          );
        }
        if (r.owners.some((o) => o !== caller.address)) {
          throw llmError(
            "FORBIDDEN",
            "this tenant is not one of your environments",
          );
        }
        let environmentId: string | null = null;
        for (const id of await deps.envIdsByTenant(a.tenantId)) {
          if (isStudioState(await deps.envState(id))) {
            environmentId = id;
            break;
          }
        }
        if (!environmentId)
          throw llmError("BAD_USER_INPUT", "not a Vetra Studio");
        if (!deps.secrets) throw notConfigured("tenant secrets (OPENBAO_ADDR)");
        const res = await deps.broker.provisionVetraKey({
          environmentId,
          tenantId: a.tenantId,
          ownerDid: caller.did,
        });
        // Per-env random secret gating vetra-cli's session-export endpoints
        // (applyStudioKey wrote it; the cold path no longer does). Only when
        // absent: a repeat call must not rotate a secret the Studio already uses.
        const existing = await deps.secrets.listSecretKeys(a.tenantId);
        if (!existing.some((k) => k.key === SESSION_EXPORT_SECRET)) {
          await deps.secrets.setSecret(
            a.tenantId,
            SESSION_EXPORT_SECRET,
            randomBytes(32).toString("hex"),
          );
        }
        return { environmentId, ...res };
      }),
    },
  };
}
