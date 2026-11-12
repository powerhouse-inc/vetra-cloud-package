import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, testConfig, type Harness } from "./harness.js";
import { namespaceExists } from "../instances/cluster.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness(testConfig());
});
afterEach(async () => {
  await h.close();
});

const status = (tenantId: string, argoLastSyncedAt: string | null) =>
  h.obsDb
    .insertInto("environment_status")
    .values({
      tenantId,
      argoSyncStatus: argoLastSyncedAt ? "SYNCED" : "UNKNOWN",
      argoHealthStatus: "HEALTHY",
      argoLastSyncedAt,
      argoMessage: null,
      configDriftDetected: 0,
      tlsCertValid: null,
      tlsCertExpiresAt: null,
      domainResolves: null,
      updatedAt: "2026-11-12T12:00:00.000Z",
    })
    .execute();

describe("namespaceExists", () => {
  it("is false with no record of the tenant", async () => {
    expect(await namespaceExists(h.obsDb, "t-none")).toBe(false);
  });

  it("is true once Argo synced the tenant, before any pod (a stopped first start has none)", async () => {
    await status("t-synced", "2026-11-12T11:59:55Z");
    expect(await namespaceExists(h.obsDb, "t-synced")).toBe(true);
  });

  it("is false while Argo never synced it", async () => {
    await status("t-new", null);
    expect(await namespaceExists(h.obsDb, "t-new")).toBe(false);
  });

  it("is true when observability saw one of its pods", async () => {
    await h.obsDb
      .insertInto("environment_pods")
      .values({
        id: "t-pod/db-0",
        tenantId: "t-pod",
        name: "db-0",
        service: "OTHER",
        component: "database",
        agent: null,
        phase: "RUNNING",
        ready: 1,
        restartCount: 0,
        image: "postgres:16",
        imageId: null,
        waitingReason: null,
        settingsRevision: null,
        updatedAt: "2026-11-12T12:00:00.000Z",
      })
      .execute();
    expect(await namespaceExists(h.obsDb, "t-pod")).toBe(true);
  });
});
