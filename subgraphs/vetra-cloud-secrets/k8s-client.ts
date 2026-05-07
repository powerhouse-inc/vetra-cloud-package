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

/**
 * 409 Conflict from k8s — the resource was created concurrently between
 * our read (which returned 404) and our create. Common when two
 * reconcileTenant calls race (e.g. a NOTIFY-triggered reconcile lands
 * during the startup full sweep). Recoverable: retry the read+update
 * path against the now-existing resource.
 */
function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
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

  /**
   * Update an existing ConfigMap to the desired data, returning
   * "unchanged" if it already matches. Used both as the primary path
   * (after a successful read) and as the recovery path when create
   * loses a 409 race against a concurrent reconcileTenant.
   */
  async function replaceConfigMap(
    spec: K8sResourceSpec,
    data: Record<string, string>,
    existing: V1ConfigMap,
  ): Promise<"updated" | "unchanged"> {
    if (mapsEqual(existing.data ?? {}, data)) return "unchanged";
    await api.replaceNamespacedConfigMap({
      name: spec.name,
      namespace: spec.namespace,
      body: { metadata: managedMetadata(spec, existing.metadata), data },
    });
    return "updated";
  }

  return {
    async upsertConfigMap(spec, data) {
      try {
        const existing = await api.readNamespacedConfigMap({
          name: spec.name,
          namespace: spec.namespace,
        });
        return replaceConfigMap(spec, data, existing);
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
            // 409 here means a concurrent reconcileTenant created it
            // between our read (404) and our create. Re-read + replace.
            if (isConflict(createErr)) {
              const existing = await api.readNamespacedConfigMap({
                name: spec.name,
                namespace: spec.namespace,
              });
              return replaceConfigMap(spec, data, existing);
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

      const replace = async (
        existing: V1Secret,
      ): Promise<"updated" | "unchanged"> => {
        if (mapsEqual(existing.data ?? {}, encoded)) return "unchanged";
        await api.replaceNamespacedSecret({
          name: spec.name,
          namespace: spec.namespace,
          body: {
            metadata: managedMetadata(spec, existing.metadata),
            type: "Opaque",
            data: encoded,
          },
        });
        return "updated";
      };

      try {
        const existing = await api.readNamespacedSecret({
          name: spec.name,
          namespace: spec.namespace,
        });
        return replace(existing);
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
            // 409 here means a concurrent reconcileTenant created it
            // between our read (404) and our create. Re-read + replace.
            if (isConflict(createErr)) {
              const existing = await api.readNamespacedSecret({
                name: spec.name,
                namespace: spec.namespace,
              });
              return replace(existing);
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
