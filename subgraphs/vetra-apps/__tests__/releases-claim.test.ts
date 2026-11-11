import { describe, expect, it } from "vitest";
import type { GraphQLError } from "graphql";
import { claim, REPO_ID } from "./harness.js";
import { assertReportAllowed } from "../releases/claim.js";

const app = { repository_id: REPO_ID };
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
    const c = claim("refs/heads/next", { runId: "412" });
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

  it("refuses a run id that is not a plain positive integer", () => {
    for (const runId of ["1e3", "0x10", " 12 ", "0", "-5", "", "01", "1.0", undefined]) {
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
