import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciIdentity,
  claim,
  makeHarness,
  OWNER,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciRegistryToken, sweepPushRobots } from "../releases/service.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.orgs.personHandles.set(OWNER, "acme");
});
afterEach(async () => {
  await h.close();
});

describe("ciRegistryToken", () => {
  it("creates the namespace's project once and a 1-day robot per call, scoped to the app", async () => {
    const app = await seedActiveApp(h);
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    const a = await ciRegistryToken(h.deps, ci, app.id);
    const issuedAt = h.clock.now.getTime();
    const b = await ciRegistryToken(h.deps, ci, app.id);
    expect(a).toMatchObject({
      registry: "cr.vetra.io",
      repository: `acme/${app.slug}`,
    });
    expect(a.password).not.toBe(b.password);
    expect(h.harbor.projects.filter((p) => p === "acme")).toHaveLength(1);
    expect(
      h.harbor.namespaceRobots.map((r) => [r.project, r.durationDays]),
    ).toStrictEqual([
      ["acme", 1],
      ["acme", 1],
    ]);
    expect(Date.parse(a.expiresAt) - issuedAt).toBe(60 * 60 * 1000);
  });

  it("refuses another app's identity", async () => {
    const app = await seedActiveApp(h);
    const ci = {
      ...ciIdentity(claim("refs/heads/main")),
      appDid: "did:key:other",
    };
    await expect(ciRegistryToken(h.deps, ci, app.id)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("the sweeper deletes robots older than an hour", async () => {
    const app = await seedActiveApp(h);
    await ciRegistryToken(h.deps, ciIdentity(claim("refs/heads/main")), app.id);
    expect(await sweepPushRobots(h.deps)).toBe(0);
    h.advance(61 * 60 * 1000);
    expect(await sweepPushRobots(h.deps)).toBe(1);
    expect(h.harbor.deletedRobots).toHaveLength(1);
  });
});
