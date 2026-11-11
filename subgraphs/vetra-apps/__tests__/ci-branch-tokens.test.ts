import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciIdentity,
  claim,
  deployAsCi,
  makeHarness,
  OWNER,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import {
  ciDeployment,
  ciRecordArtifact,
  ciRegistryCredentials,
} from "../service.js";
import { ciRegistryToken } from "../releases/service.js";

// Renown's BRANCH tokens (any non-production branch push) must not reach the
// old deploy path: it behaves as before Renown issued them.
let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.orgs.personHandles.set(OWNER, "acme");
});
afterEach(async () => {
  await h.close();
});

const branchCi = () =>
  ciIdentity(
    claim("refs/heads/feature", {
      refClass: "BRANCH",
      runId: "9",
      releaseBranch: false,
    }),
  );

describe("BRANCH tokens on the old CI path", () => {
  it("cannot fetch the App's registry credentials", async () => {
    const app = await seedActiveApp(h);
    await expect(
      ciRegistryCredentials(h.deps, branchCi(), app.id),
    ).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
      message: expect.stringContaining("BRANCH"),
    });
    await expect(
      ciRegistryCredentials(
        h.deps,
        ciIdentity(claim("refs/heads/main")),
        app.id,
      ),
    ).resolves.toBeTruthy();
  });

  it("cannot record artifacts", async () => {
    const app = await seedActiveApp(h);
    await expect(
      ciRecordArtifact(h.deps, branchCi(), {
        appId: app.id,
        kind: "FUSION_IMAGE",
        name: "shop",
        version: "1.2.3",
        reference: "cr.vetra.io/p/shop:1.2.3",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("cannot read deployments", async () => {
    const app = await seedActiveApp(h);
    const d = await deployAsCi(h.deps, claim("refs/heads/main"), {
      appId: app.id,
      kind: "PRODUCTION",
      gitRef: "refs/heads/main",
      sha: "abcdef1234567",
      packages: [{ name: "@acme/shop", version: "1.0.0" }],
    } as never);
    expect(
      await ciDeployment(h.deps, ciIdentity(claim("refs/heads/main")), d.id),
    ).not.toBeNull();
    expect(await ciDeployment(h.deps, branchCi(), d.id)).toBeNull();
  });

  it("still gets a push token on the new path (builds from any branch)", async () => {
    const app = await seedActiveApp(h);
    await expect(
      ciRegistryToken(h.deps, branchCi(), app.id),
    ).resolves.toMatchObject({ registry: "cr.vetra.io" });
  });
});
