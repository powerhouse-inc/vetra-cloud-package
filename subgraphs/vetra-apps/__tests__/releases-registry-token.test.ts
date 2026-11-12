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
  it("creates the namespace's project once and a 1-day namespace robot per call", async () => {
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

  it("makes the namespace's stable release tags immutable on every token, for existing projects too", async () => {
    const app = await seedActiveApp(h);
    h.harbor.existing.add("acme"); // created before the rule existed
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    await ciRegistryToken(h.deps, ci, app.id);
    await ciRegistryToken(h.deps, ci, app.id);
    expect(h.harbor.immutable).toStrictEqual(["acme", "acme"]);
  });

  it("still issues the token when Harbor cannot set the rule, and logs it", async () => {
    const app = await seedActiveApp(h);
    h.harbor.immutableFails = true;
    const warned: string[] = [];
    h.deps.logger = { ...h.deps.logger, warn: (m: string) => warned.push(m) };
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    await expect(ciRegistryToken(h.deps, ci, app.id)).resolves.toMatchObject({
      repository: `acme/${app.slug}`,
    });
    expect(warned.join("\n")).toMatch(/acme.*immutable.*harbor down/);
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

  it("refuses a token without a vetra claim, or minted for another repository", async () => {
    const app = await seedActiveApp(h);
    for (const ci of [
      ciIdentity(null),
      ciIdentity(claim("refs/heads/main", { repositoryId: "9999" })),
    ]) {
      await expect(ciRegistryToken(h.deps, ci, app.id)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    }
    expect(h.harbor.namespaceRobots).toHaveLength(0);
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
