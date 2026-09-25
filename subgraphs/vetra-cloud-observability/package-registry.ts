import type { Kysely } from "kysely";

/**
 * The registries an environment may install packages from. Production uses
 * registry.vetra.io; registry.dev.vetra.io is for testing.
 */
export const ALLOWED_PACKAGE_REGISTRIES = new Set([
  "https://registry.vetra.io",
  "https://registry.dev.vetra.io",
]);

/**
 * Statuses of a deployed environment. SET_DEFAULT_PACKAGE_REGISTRY alone does
 * not move these to CHANGES_PENDING, so without a redeploy the new registry
 * would only reach the tenant on the owner's next unrelated change.
 */
const DEPLOYED_STATUSES = new Set([
  "READY",
  "CHANGES_APPROVED",
  "CHANGES_PUSHED",
  "DEPLOYING",
  "DEPLOYMENt_FAILED",
]);

export interface PackageRegistryResolverDeps {
  envDb: Kysely<any>;
  dispatch: (documentId: string, type: string, input: Record<string, unknown>) => Promise<void>;
}

type Caller = {
  user?: { address: string };
  isAdmin?: (address: string) => boolean;
};

/**
 * `setDefaultPackageRegistry` resolver. Owner-or-admin gated.
 *
 * Sets the environment's default package registry. For a deployed environment
 * it then re-sets the current label (SET_LABEL is the op that marks a deployed
 * env CHANGES_PENDING; the reducer for the registry does not, and changing
 * that reducer would alter documents rebuilt from their history) and approves,
 * so gitops re-renders the tenant with the new registry. A slept (STOPPED)
 * environment picks it up on wake; a DRAFT or CHANGES_PENDING one on its
 * owner's next deploy: approving there would ship the owner's other edits.
 *
 * Errors: UNAUTHENTICATED, INVALID_REGISTRY, ENV_NOT_FOUND, FORBIDDEN.
 */
export function createPackageRegistryResolver(deps: PackageRegistryResolverDeps) {
  return {
    Mutation: {
      setDefaultPackageRegistry: async (
        _parent: unknown,
        { tenantId, registryUrl }: { tenantId: string; registryUrl: string },
        ctx: Caller,
      ) => {
        const caller = ctx.user?.address.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");

        const registry = registryUrl.trim().replace(/\/+$/, "");
        if (!ALLOWED_PACKAGE_REGISTRIES.has(registry)) {
          throw new Error("INVALID_REGISTRY");
        }

        const env = (await deps.envDb
          .selectFrom("environments")
          .select(["id", "name", "status", "owner"])
          .where("tenantId", "=", tenantId)
          .executeTakeFirst()) as
          | { id: string; name: string | null; status: string | null; owner: string | null }
          | undefined;
        if (!env) throw new Error("ENV_NOT_FOUND");

        const isOwner = !!env.owner && env.owner.toLowerCase() === caller;
        const isAdmin = ctx.isAdmin?.(caller) ?? false;
        if (!isOwner && !isAdmin) throw new Error("FORBIDDEN");

        await deps.dispatch(env.id, "SET_DEFAULT_PACKAGE_REGISTRY", {
          defaultPackageRegistry: registry,
        });

        const redeploy = !!env.status && DEPLOYED_STATUSES.has(env.status) && !!env.name;
        if (redeploy) {
          await deps.dispatch(env.id, "SET_LABEL", { label: env.name });
          await deps.dispatch(env.id, "APPROVE_CHANGES", {});
        }

        return { tenantId, defaultPackageRegistry: registry, redeployed: redeploy };
      },
    },
  };
}
