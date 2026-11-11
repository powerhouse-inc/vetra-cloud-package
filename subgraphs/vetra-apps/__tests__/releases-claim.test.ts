import { describe, expect, it } from "vitest";
import type { GraphQLError } from "graphql";
import { claim, REPO_ID } from "./harness.js";
import { assertReportAllowed } from "../releases/claim.js";

const app = {
  repository_id: REPO_ID,
  production_branch: "main",
  release_branches: '["next","*.x"]',
};
const sha = "abcdef1234567";
const code = (fn: () => unknown) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    return (e as GraphQLError).extensions?.code;
  }
};

describe("assertReportAllowed", () => {
  it("allows a release pushed to its branch and returns the run id", () => {
    const c = claim("refs/heads/next", { runId: "412", releaseBranch: true });
    expect(
      assertReportAllowed(app, c, {
        kind: "release",
        version: "2.0.0-beta.1",
        branch: "next",
        pr: null,
        commit: sha,
      }),
    ).toStrictEqual({ run: 412 });
  });

  it("allows releases only from the production branch or a listed release branch, with Renown's releaseBranch", () => {
    const release = (branch: string, extra: Record<string, unknown>) =>
      code(() =>
        assertReportAllowed(
          app,
          claim(`refs/heads/${branch}`, { runId: "7", ...extra }),
          {
            kind: "release",
            version: "2.0.0",
            branch,
            pr: null,
            commit: sha,
          },
        ),
      );
    expect(release("main", {})).toBe("OK");
    expect(release("next", { releaseBranch: true })).toBe("OK");
    expect(release("1.x", { releaseBranch: true })).toBe("OK");
    // Not listed by the app, whatever the claim says.
    expect(release("feature", { releaseBranch: true })).toBe("FORBIDDEN");
    expect(release("release/1.x", { releaseBranch: true })).toBe("FORBIDDEN");
    // Listed, but Renown did not vouch for it (false, or not said).
    expect(release("next", { releaseBranch: false })).toBe("FORBIDDEN");
    expect(release("next", { releaseBranch: undefined })).toBe("FORBIDDEN");
    expect(release("main", { releaseBranch: false })).toBe("FORBIDDEN");
    // A Renown before release branches sets no flag but mints only
    // PRODUCTION tokens for the production branch: those still release.
    expect(release("main", { releaseBranch: undefined })).toBe("OK");
    expect(
      release("main", { releaseBranch: undefined, refClass: "BRANCH" }),
    ).toBe("FORBIDDEN");
    // An app without the setting (row before the migration) has only main.
    expect(
      code(() =>
        assertReportAllowed(
          { repository_id: REPO_ID, production_branch: "main" },
          claim("refs/heads/next", { runId: "7", releaseBranch: true }),
          {
            kind: "release",
            version: "2.0.0",
            branch: "next",
            pr: null,
            commit: sha,
          },
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("explains a release refused for its branch", () => {
    expect(() =>
      assertReportAllowed(
        app,
        claim("refs/heads/feature", { runId: "7", releaseBranch: false }),
        {
          kind: "release",
          version: "2.0.0",
          branch: "feature",
          pr: null,
          commit: sha,
        },
      ),
    ).toThrow(/feature is not a release branch/);
  });

  it("allows builds from any branch, release branch or not", () => {
    expect(
      code(() =>
        assertReportAllowed(
          app,
          claim("refs/heads/feature/x", { runId: "3", releaseBranch: false }),
          {
            kind: "build",
            version: "1.5.0-feature-x.1",
            branch: "feature/x",
            pr: null,
            commit: sha,
          },
        ),
      ),
    ).toBe("OK");
  });

  it("refuses a run id that is not a plain positive integer", () => {
    for (const runId of [
      "1e3",
      "0x10",
      " 12 ",
      "0",
      "-5",
      "",
      "01",
      "1.0",
      undefined,
    ]) {
      expect(
        code(() =>
          assertReportAllowed(app, claim("refs/heads/main", { runId }), {
            kind: "release",
            version: "1.5.0",
            branch: "main",
            pr: null,
            commit: sha,
          }),
        ),
        String(runId),
      ).toBe("FORBIDDEN");
    }
  });

  it("allows branch and PR builds", () => {
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }), {
          kind: "build",
          version: "1.5.0-main.3",
          branch: "main",
          pr: null,
          commit: sha,
        }),
      ),
    ).toBe("OK");
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/pull/12/merge", { runId: "2" }), {
          kind: "build",
          version: "1.5.0-pr.12.1",
          branch: null,
          pr: 12,
          commit: sha,
        }),
      ),
    ).toBe("OK");
  });

  it("refuses another repo, another commit, a mismatched branch or PR", () => {
    const ok = {
      kind: "build" as const,
      version: "1.5.0-main.3",
      branch: "main",
      pr: null,
      commit: sha,
    };
    expect(
      code(() =>
        assertReportAllowed(
          app,
          claim("refs/heads/main", { runId: "1", repositoryId: "9" }),
          ok,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }), {
          ...ok,
          commit: "other",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(() =>
        assertReportAllowed(
          app,
          claim("refs/heads/feature", { runId: "1" }),
          ok,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/pull/13/merge", { runId: "1" }), {
          ...ok,
          branch: null,
          pr: 12,
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("refuses a release from a PR and a kind that does not match the version", () => {
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/pull/12/merge", { runId: "1" }), {
          kind: "release",
          version: "1.5.0",
          branch: null,
          pr: 12,
          commit: sha,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(() =>
        assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }), {
          kind: "release",
          version: "1.5.0-main.3",
          branch: "main",
          pr: null,
          commit: sha,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  it("refuses a token without a claim or a run id", () => {
    const ok = {
      kind: "build" as const,
      version: "1.5.0-main.3",
      branch: "main",
      pr: null,
      commit: sha,
    };
    expect(code(() => assertReportAllowed(app, null, ok))).toBe("FORBIDDEN");
    expect(
      code(() => assertReportAllowed(app, claim("refs/heads/main"), ok)),
    ).toBe("FORBIDDEN");
  });
});
