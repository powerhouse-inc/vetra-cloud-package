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

function is404(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; response?: { statusCode?: unknown } };
  if (e.code === 404) return true;
  if (
    typeof e.response === "object" &&
    e.response !== null &&
    e.response.statusCode === 404
  ) {
    return true;
  }
  return false;
}

export function createK8sClient(): K8sClient {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(CoreV1Api);

  async function namespaceExists(namespace: string): Promise<boolean> {
    try {
      await api.readNamespace({ name: namespace });
      return true;
    } catch (err: unknown) {
      if (is404(err)) return false;
      throw err;
    }
  }

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

  return {
    async upsertConfigMap(spec, data) {
      if (!(await namespaceExists(spec.namespace))) {
        console.warn(
          `[k8s] namespace '${spec.namespace}' does not exist; skipping ConfigMap '${spec.name}'`,
        );
        return "skipped";
      }

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
        if (is404(err)) {
          const body: V1ConfigMap = {
            metadata: managedMetadata(spec),
            data,
          };
          await api.createNamespacedConfigMap({
            namespace: spec.namespace,
            body,
          });
          return "created";
        }
        throw err;
      }
    },

    async upsertSecret(spec, data) {
      if (!(await namespaceExists(spec.namespace))) {
        console.warn(
          `[k8s] namespace '${spec.namespace}' does not exist; skipping Secret '${spec.name}'`,
        );
        return "skipped";
      }

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
        if (is404(err)) {
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
        }
        throw err;
      }
    },
  };
}
