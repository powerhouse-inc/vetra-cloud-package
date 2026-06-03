import type { Kysely } from "kysely";

/**
 * Minimal Kubernetes surface for service rollout-restarts. Defined as an
 * interface so the resolver can be unit-tested with a stub and the
 * production implementation can be lazy-loaded (avoids paying the
 * @kubernetes/client-node import cost in tests).
 */
export interface RestartK8sClient {
  /** Names of Deployments in `namespace` matching the label selector. */
  listDeploymentNames(
    namespace: string,
    labelSelector: string,
  ): Promise<string[]>;
  /**
   * Trigger a rolling restart of one Deployment by stamping the standard
   * `kubectl.kubernetes.io/restartedAt` pod-template annotation (same
   * mechanism as `kubectl rollout restart`). Throws DEPLOYMENT_NOT_FOUND
   * if the Deployment is gone (404).
   */
  restartDeployment(
    namespace: string,
    name: string,
    restartedAt: string,
  ): Promise<void>;
}

export type RestartResolverDeps = {
  /** Kysely handle for the processor's `vetra-cloud-environments` namespace. */
  envDb: Kysely<any>;
  k8s: RestartK8sClient;
};

/** Auth context shape injected by reactor-api into resolver `context`. */
type Caller = { user?: { address: string }; isAdmin?: (address: string) => boolean };

/**
 * Build the Deployment label selector for a service. Agents (CLINT) are
 * disambiguated by their prefix via the chart's `clint.vetra.io/agent`
 * label; CONNECT/SWITCHBOARD select by the chart's component label. There
 * is exactly one Deployment per (env, component) and per (env, agent),
 * so the caller treats >1 match as AMBIGUOUS_SERVICE.
 */
export function deploymentSelector(
  service: string,
  agentPrefix: string | null | undefined,
): string {
  if (service === "CLINT") {
    if (!agentPrefix) throw new Error("AMBIGUOUS_SERVICE");
    return `clint.vetra.io/agent=${agentPrefix}`;
  }
  return `app.kubernetes.io/component=${service.toLowerCase()}`;
}

/**
 * `restartEnvironmentService` resolver. Owner-or-admin gated. Resolves the
 * target Deployment by label (robust to the chart's 63-char name
 * truncation) and triggers a rolling restart. The env's k8s namespace is
 * its `tenantId` (the chart deploys each environment into a namespace named
 * for its tenantId).
 *
 * Errors (plain `Error("CODE")`, matching the subgraph convention):
 * RESTART_NOT_CONFIGURED, UNAUTHENTICATED, ENV_NOT_FOUND, FORBIDDEN,
 * AMBIGUOUS_SERVICE, DEPLOYMENT_NOT_FOUND.
 */
export function createRestartResolver(deps?: RestartResolverDeps) {
  return {
    Mutation: {
      restartEnvironmentService: async (
        _parent: unknown,
        {
          tenantId,
          service,
          agentPrefix,
        }: { tenantId: string; service: string; agentPrefix?: string | null },
        ctx: Caller,
      ) => {
        if (!deps) throw new Error("RESTART_NOT_CONFIGURED");

        const caller = ctx.user?.address?.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");
        const isAdmin = ctx.isAdmin?.(caller) ?? false;

        const envRow = (await deps.envDb
          .selectFrom("environments")
          .select(["tenantId", "owner"])
          .where("tenantId", "=", tenantId)
          .executeTakeFirst()) as { owner: string | null } | undefined;
        if (!envRow) throw new Error("ENV_NOT_FOUND");
        const isOwner =
          !!envRow.owner && envRow.owner.toLowerCase() === caller;
        if (!isOwner && !isAdmin) throw new Error("FORBIDDEN");

        // Throws AMBIGUOUS_SERVICE for CLINT without a prefix.
        const selector = deploymentSelector(service, agentPrefix);
        const names = await deps.k8s.listDeploymentNames(tenantId, selector);
        if (names.length === 0) throw new Error("DEPLOYMENT_NOT_FOUND");
        if (names.length > 1) throw new Error("AMBIGUOUS_SERVICE");

        const deploymentName = names[0];
        await deps.k8s.restartDeployment(
          tenantId,
          deploymentName,
          new Date().toISOString(),
        );
        return { ok: true, deploymentName, message: null };
      },
    },
  };
}

/**
 * Production implementation. Uses the in-cluster ServiceAccount via
 * `loadFromCluster()` (the subgraph runs in-cluster). RBAC grants
 * `apps/deployments: get, list, patch` cluster-wide.
 */
export async function createDefaultRestartK8sClient(): Promise<RestartK8sClient> {
  const { KubeConfig, AppsV1Api, PatchStrategy, setHeaderOptions } =
    await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const apps = kc.makeApiClient(AppsV1Api);

  return {
    async listDeploymentNames(namespace, labelSelector) {
      const res = await apps.listNamespacedDeployment({
        namespace,
        labelSelector,
      });
      return res.items
        .map((d) => d.metadata?.name ?? "")
        .filter((n) => n.length > 0);
    },
    async restartDeployment(namespace, name, restartedAt) {
      // Native-resource patch defaults to JSON Patch (an array of ops) in
      // client-node, which rejects a merge object with "cannot unmarshal
      // object into []jsonPatchOp". Force a strategic-merge patch via the
      // options arg so the partial object is merged into the pod template —
      // same mechanism as `kubectl rollout restart`.
      try {
        await apps.patchNamespacedDeployment(
          {
            namespace,
            name,
            body: {
              spec: {
                template: {
                  metadata: {
                    annotations: {
                      "kubectl.kubernetes.io/restartedAt": restartedAt,
                    },
                  },
                },
              },
            },
          },
          setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
        );
      } catch (err: unknown) {
        const code =
          (err as { code?: number; statusCode?: number })?.code ??
          (err as { code?: number; statusCode?: number })?.statusCode;
        if (code === 404) throw new Error("DEPLOYMENT_NOT_FOUND");
        throw err;
      }
    },
  };
}
