import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciIdentity,
  claim,
  INSTALLATION,
  makeHarness,
  owner,
  REPO_ID,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciGithubToken } from "../releases/service.js";
import { updateApp } from "../service.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

describe("ciGithubToken (spec 14.1)", () => {
  it("mints the release token for a push to the production branch", async () => {
    const app = await seedActiveApp(h);
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    expect(await ciGithubToken(h.deps, ci, app.id)).toStrictEqual({
      token: "ghs_release",
      expiresAt: "2026-10-02T13:00:00.000Z",
    });
    expect(h.github.calls.createReleaseToken).toStrictEqual([
      [INSTALLATION, REPO_ID],
    ]);
  });

  it("a listed release branch gets one when Renown marks it too", async () => {
    const app = await seedActiveApp(h);
    await updateApp(h.deps, owner, app.id, { releaseBranches: ["next"] });
    const ci = ciIdentity(
      claim("refs/heads/next", { refClass: "BRANCH", releaseBranch: true }),
    );
    await expect(ciGithubToken(h.deps, ci, app.id)).resolves.toMatchObject({
      token: "ghs_release",
    });
  });

  it("refuses PRs, dispatches, other branches, unmarked branches and other repositories", async () => {
    const app = await seedActiveApp(h);
    await updateApp(h.deps, owner, app.id, { releaseBranches: ["next"] });
    for (const c of [
      claim("refs/pull/3/merge"),
      claim("refs/heads/main", { eventName: "workflow_dispatch" }),
      claim("refs/heads/feature", { refClass: "BRANCH", releaseBranch: false }),
      claim("refs/heads/next", { refClass: "BRANCH", releaseBranch: false }),
      claim("refs/heads/main", { releaseBranch: false }),
      claim("refs/heads/main", { repositoryId: "9999" }),
    ]) {
      await expect(
        ciGithubToken(h.deps, ciIdentity(c), app.id),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    expect(h.github.calls.createReleaseToken).toBeUndefined();
  });

  it("GitHub refusing the token is a 503 that names the permissions", async () => {
    const app = await seedActiveApp(h);
    h.deps.github!.createReleaseToken = async () => {
      throw new Error("github: POST access_tokens → 422");
    };
    await expect(
      ciGithubToken(h.deps, ciIdentity(claim("refs/heads/main")), app.id),
    ).rejects.toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
      message: expect.stringMatching(/pull_requests: write/),
    });
  });
});
