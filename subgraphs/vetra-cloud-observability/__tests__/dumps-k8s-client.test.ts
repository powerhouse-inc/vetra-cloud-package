import { describe, expect, it, vi } from "vitest";
import type { V1Job } from "@kubernetes/client-node";

const created = vi.fn();
vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient() {
      return { createNamespacedJob: created };
    }
  },
  BatchV1Api: class {},
  CoreV1Api: class {},
}));

import { createDefaultDumpsK8sClient } from "../dumps/k8s-client.js";

const job = { metadata: { name: "pgrestore-r1" } } as V1Job;

describe("createJob", () => {
  it("treats 409 AlreadyExists as success: the Job an earlier attempt created", async () => {
    created.mockRejectedValueOnce({ code: 409 });
    const c = await createDefaultDumpsK8sClient();
    expect(await c.createJob("ns", job)).toBe("pgrestore-r1");
  });
  it("still throws other errors", async () => {
    created.mockRejectedValueOnce({ code: 500 });
    const c = await createDefaultDumpsK8sClient();
    await expect(c.createJob("ns", job)).rejects.toEqual({ code: 500 });
  });
});
