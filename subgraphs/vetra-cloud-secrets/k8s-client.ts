import {
  KubeConfig,
  CoreV1Api,
  type V1ConfigMap,
  type V1Secret,
  type V1ObjectMeta,
} from "@kubernetes/client-node";

export interface K8sResourceSpec {
  namespace: string;
  name: string;
  managedLabel: string;
}

export interface K8sClient {
  upsertConfigMap(
    spec: K8sResourceSpec,
    data: Record<string, string>,
  ): Promise<"created" | "updated" | "unchanged" | "skipped">;
  upsertSecret(
    spec: K8sResourceSpec,
    data: Record<string, string>,
  ): Promise<"created" | "updated" | "unchanged" | "skipped">;
}

function statusCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; response?: { statusCode?: unknown } };
  if (typeof e.code === "number") return e.code;
  if (
    typeof e.response === "object" &&
    e.response !== null &&
    typeof e.response.statusCode === "number"
  ) {
    return e.response.statusCode;
  }
  return null;
}

function isNotFound(err: unknown): boolean {
  return statusCode(err) === 404;
}

function isForbidden(err: unknown): boolean {
  return statusCode(err) === 403;
}

export function createK8sClient(): K8sClient {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(CoreV1Api);

  function managedMetadata(
    spec: K8sResourceSpec,
    existing?: V1ObjectMeta,
  ): V1ObjectMeta {
    const labels = {
      ...(existing?.labels ?? {}),
      "app.kubernetes.io/managed-by": spec.managedLabel,
    };
    return {
      name: spec.name,
      namespace: spec.namespace,
      labels,
    };
  }

  function mapsEqual(
    a: Record<string, string>,
    b: Record<string, string>,
  ): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) if (a[k] !== b[k]) return false;
    return true;
  }

  // Missing tenant namespace OR missing RBAC — both observable as a 404 or
  // 403 from the K8s API. Logged once, treated as a no-op. The tenant's
  // Helm chart RoleBinding landing (or the namespace appearing) flips this
  // on automatically at the next reconcile tick.
  function skippable(err: unknown): boolean {
    return isNotFound(err) || isForbidden(err);
  }

  return {
    async upsertConfigMap(spec, data) {
      try {
        const existing = await api.readNamespacedConfigMap({
          name: spec.name,
          namespace: spec.namespace,
        });
        const current = existing.data ?? {};
        if (mapsEqual(current, data)) return "unchanged";

        const body: V1ConfigMap = {
          metadata: managedMetadata(spec, existing.metadata),
          data,
        };
        await api.replaceNamespacedConfigMap({
          name: spec.name,
          namespace: spec.namespace,
          body,
        });
        return "updated";
      } catch (err: unknown) {
        if (isNotFound(err)) {
          try {
            const body: V1ConfigMap = {
              metadata: managedMetadata(spec),
              data,
            };
            await api.createNamespacedConfigMap({
              namespace: spec.namespace,
              body,
            });
            return "created";
          } catch (createErr: unknown) {
            if (skippable(createErr)) {
              console.warn(
                `[k8s] cannot create ConfigMap ${spec.namespace}/${spec.name} (namespace missing or RBAC not applied); skipping`,
              );
              return "skipped";
            }
            throw createErr;
          }
        }
        if (isForbidden(err)) {
          console.warn(
            `[k8s] cannot read ConfigMap ${spec.namespace}/${spec.name} (RBAC not applied); skipping`,
          );
          return "skipped";
        }
        throw err;
      }
    },

    async upsertSecret(spec, data) {
      // K8s Secret.data is base64-encoded; we use stringData for writes and compare via decoded form.
      const encoded: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        encoded[k] = Buffer.from(v, "utf8").toString("base64");
      }

      try {
        const existing = await api.readNamespacedSecret({
          name: spec.name,
          namespace: spec.namespace,
        });
        const currentEncoded = existing.data ?? {};
        if (mapsEqual(currentEncoded, encoded)) return "unchanged";

        const body: V1Secret = {
          metadata: managedMetadata(spec, existing.metadata),
          type: "Opaque",
          data: encoded,
        };
        await api.replaceNamespacedSecret({
          name: spec.name,
          namespace: spec.namespace,
          body,
        });
        return "updated";
      } catch (err: unknown) {
        if (isNotFound(err)) {
          try {
            const body: V1Secret = {
              metadata: managedMetadata(spec),
              type: "Opaque",
              data: encoded,
            };
            await api.createNamespacedSecret({
              namespace: spec.namespace,
              body,
            });
            return "created";
          } catch (createErr: unknown) {
            if (skippable(createErr)) {
              console.warn(
                `[k8s] cannot create Secret ${spec.namespace}/${spec.name} (namespace missing or RBAC not applied); skipping`,
              );
              return "skipped";
            }
            throw createErr;
          }
        }
        if (isForbidden(err)) {
          console.warn(
            `[k8s] cannot read Secret ${spec.namespace}/${spec.name} (RBAC not applied); skipping`,
          );
          return "skipped";
        }
        throw err;
      }
    },
  };
}
