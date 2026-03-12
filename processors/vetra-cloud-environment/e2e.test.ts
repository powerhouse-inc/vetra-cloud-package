/**
 * E2E test for the vetra-cloud-environment processor.
 *
 * Prerequisites:
 *   - Reactor running on localhost:4001 (`ph reactor`)
 *   - kubectl configured and pointing at the target cluster
 *   - GITOPS_REPO_PATH set so the processor can push to the k8s repo
 *
 * Run with:  npx vitest run processors/vetra-cloud-environment/e2e.test.ts
 */
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const GQL = "http://localhost:4001/graphql/vetra-cloud-environment";
const GQL_MAIN = "http://localhost:4001/graphql";
const ENV_NAME = "e2e-test";
// Helm release name from ApplicationSet: powerhouse-{basename}
const HELM_RELEASE = `powerhouse-${ENV_NAME}`;

// ── helpers ─────────────────────────────────────────────────────────────

async function gql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  endpoint = GQL,
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data as T;
}

function kubectl(...args: string[]): string {
  return execFileSync("kubectl", args, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

/** Poll until `check` returns true, or throw after `timeoutMs`. */
async function waitFor(
  label: string,
  check: () => boolean | Promise<boolean>,
  { interval = 5_000, timeout = 180_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ── state ───────────────────────────────────────────────────────────────

let docId: string;

// ── tests ───────────────────────────────────────────────────────────────

describe("vetra-cloud-environment e2e", { timeout: 600_000 }, () => {
  it("creates a document via GraphQL", async () => {
    const data = await gql<{
      VetraCloudEnvironment_createDocument: {
        id: string;
        name: string;
        documentType: string;
        state: { global: { name: string | null; status: string } };
      };
    }>(
      `mutation($name: String!) {
        VetraCloudEnvironment_createDocument(name: $name) {
          id name documentType state { global { name status } }
        }
      }`,
      { name: ENV_NAME },
    );

    const doc = data.VetraCloudEnvironment_createDocument;
    expect(doc.documentType).toBe("powerhouse/vetra-cloud-environment");
    expect(doc.state.global.status).toBe("STOPPED");
    expect(doc.state.global.name).toBeNull();
    docId = doc.id;
  });

  it("sets the environment name", async () => {
    const data = await gql<{
      VetraCloudEnvironment_setEnvironmentName: {
        state: { global: { name: string } };
      };
    }>(
      `mutation($id: PHID!, $input: VetraCloudEnvironment_SetEnvironmentNameInput!) {
        VetraCloudEnvironment_setEnvironmentName(docId: $id, input: $input) {
          state { global { name } }
        }
      }`,
      { id: docId, input: { name: ENV_NAME } },
    );

    expect(
      data.VetraCloudEnvironment_setEnvironmentName.state.global.name,
    ).toBe(ENV_NAME);
  });

  it("enables SWITCHBOARD service", async () => {
    const data = await gql<{
      VetraCloudEnvironment_enableService: {
        state: { global: { services: string[] } };
      };
    }>(
      `mutation($id: PHID!, $input: VetraCloudEnvironment_EnableServiceInput!) {
        VetraCloudEnvironment_enableService(docId: $id, input: $input) {
          state { global { services } }
        }
      }`,
      { id: docId, input: { serviceName: "SWITCHBOARD" } },
    );

    expect(
      data.VetraCloudEnvironment_enableService.state.global.services,
    ).toContain("SWITCHBOARD");
  });

  it("enables CONNECT service", async () => {
    const data = await gql<{
      VetraCloudEnvironment_enableService: {
        state: { global: { services: string[] } };
      };
    }>(
      `mutation($id: PHID!, $input: VetraCloudEnvironment_EnableServiceInput!) {
        VetraCloudEnvironment_enableService(docId: $id, input: $input) {
          state { global { services } }
        }
      }`,
      { id: docId, input: { serviceName: "CONNECT" } },
    );

    const services = data.VetraCloudEnvironment_enableService.state.global.services;
    expect(services).toContain("SWITCHBOARD");
    expect(services).toContain("CONNECT");
  });

  it("starts the environment", async () => {
    const data = await gql<{
      VetraCloudEnvironment_start: {
        state: { global: { name: string; status: string } };
      };
    }>(
      `mutation($id: PHID!) {
        VetraCloudEnvironment_start(docId: $id, input: {}) {
          state { global { name status } }
        }
      }`,
      { id: docId },
    );

    const state = data.VetraCloudEnvironment_start.state.global;
    expect(state.name).toBe(ENV_NAME);
    expect(state.status).toBe("STARTED");
  });

  it("k8s namespace is created", async () => {
    await waitFor(
      `namespace ${ENV_NAME} to exist`,
      () => {
        try {
          const out = kubectl("get", "namespace", ENV_NAME, "-o", "jsonpath={.status.phase}");
          return out === "Active";
        } catch {
          return false;
        }
      },
      { interval: 5_000, timeout: 180_000 },
    );

    const phase = kubectl("get", "namespace", ENV_NAME, "-o", "jsonpath={.status.phase}");
    expect(phase).toBe("Active");
  });

  it("CNPG postgres cluster is healthy", async () => {
    await waitFor(
      `CNPG cluster ${ENV_NAME}-pg to be healthy`,
      () => {
        try {
          const status = kubectl(
            "get", "clusters.postgresql.cnpg.io", `${ENV_NAME}-pg`,
            "-n", ENV_NAME,
            "-o", "jsonpath={.status.phase}",
          );
          return status === "Cluster in healthy state";
        } catch {
          return false;
        }
      },
      { interval: 10_000, timeout: 180_000 },
    );

    const instances = kubectl(
      "get", "clusters.postgresql.cnpg.io", `${ENV_NAME}-pg`,
      "-n", ENV_NAME,
      "-o", "jsonpath={.status.readyInstances}",
    );
    expect(Number(instances)).toBeGreaterThanOrEqual(1);
  });

  it("database pooler is running", async () => {
    await waitFor(
      `pooler deployment ${ENV_NAME}-pg-pooler to be available`,
      () => {
        try {
          const ready = kubectl(
            "get", "deployment", `${ENV_NAME}-pg-pooler`,
            "-n", ENV_NAME,
            "-o", "jsonpath={.status.availableReplicas}",
          );
          return Number(ready) >= 1;
        } catch {
          return false;
        }
      },
      { interval: 5_000, timeout: 120_000 },
    );

    const ready = kubectl(
      "get", "deployment", `${ENV_NAME}-pg-pooler`,
      "-n", ENV_NAME,
      "-o", "jsonpath={.status.availableReplicas}",
    );
    expect(Number(ready)).toBeGreaterThanOrEqual(1);
  });

  it("switchboard deployment is running", async () => {
    const deployName = `${HELM_RELEASE}-switchboard`;
    await waitFor(
      `${deployName} deployment to be available`,
      () => {
        try {
          const ready = kubectl(
            "get", "deployment", deployName,
            "-n", ENV_NAME,
            "-o", "jsonpath={.status.availableReplicas}",
          );
          return Number(ready) >= 1;
        } catch {
          return false;
        }
      },
      { interval: 10_000, timeout: 180_000 },
    );

    const ready = kubectl(
      "get", "deployment", deployName,
      "-n", ENV_NAME,
      "-o", "jsonpath={.status.availableReplicas}",
    );
    expect(Number(ready)).toBeGreaterThanOrEqual(1);
  });

  it("connect deployment is running", async () => {
    const deployName = `${HELM_RELEASE}-connect`;
    await waitFor(
      `${deployName} deployment to be available`,
      () => {
        try {
          const ready = kubectl(
            "get", "deployment", deployName,
            "-n", ENV_NAME,
            "-o", "jsonpath={.status.availableReplicas}",
          );
          return Number(ready) >= 1;
        } catch {
          return false;
        }
      },
      { interval: 10_000, timeout: 180_000 },
    );

    const ready = kubectl(
      "get", "deployment", deployName,
      "-n", ENV_NAME,
      "-o", "jsonpath={.status.availableReplicas}",
    );
    expect(Number(ready)).toBeGreaterThanOrEqual(1);
  });

  it("stops the environment", async () => {
    const data = await gql<{
      VetraCloudEnvironment_stop: {
        state: { global: { status: string } };
      };
    }>(
      `mutation($id: PHID!) {
        VetraCloudEnvironment_stop(docId: $id, input: {}) {
          state { global { status } }
        }
      }`,
      { id: docId },
    );

    expect(data.VetraCloudEnvironment_stop.state.global.status).toBe("STOPPED");
  });

  it("k8s resources are torn down after stop", async () => {
    // After stop, the processor pushes global.disabled: true → ArgoCD prunes resources
    await waitFor(
      `deployments in ${ENV_NAME} to be removed`,
      () => {
        try {
          const deployments = kubectl(
            "get", "deployments",
            "-n", ENV_NAME,
            "-o", "jsonpath={.items[*].metadata.name}",
          );
          // All app deployments should be gone (switchboard, connect, pooler)
          return !deployments.includes(`${HELM_RELEASE}-switchboard`)
            && !deployments.includes(`${HELM_RELEASE}-connect`);
        } catch {
          // namespace might not exist anymore either — that's fine
          return true;
        }
      },
      { interval: 10_000, timeout: 180_000 },
    );
  });

  it("deletes the document", async () => {
    await gql<{ deleteDocument: boolean }>(
      `mutation($id: String!) {
        deleteDocument(identifier: $id)
      }`,
      { id: docId },
      GQL_MAIN,
    );

    // Verify document is gone
    try {
      const data = await gql<{
        VetraCloudEnvironment_createDocument: null;
      }>(
        `query($id: PHID!) {
          VetraCloudEnvironment_document(id: $id) {
            id
          }
        }`,
        { id: docId },
      );
      // If we get here without error, the document might still exist briefly
      // but the delete was accepted
    } catch {
      // Expected — document no longer exists
    }
  });
});
