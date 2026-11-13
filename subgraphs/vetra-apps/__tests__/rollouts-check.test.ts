import { describe, expect, it } from "vitest";
import {
  planFitProblem,
  powerhouseAtLeast,
  releaseProblem,
} from "../rollouts/check.js";
import type { ReleaseRow } from "../releases/repo.js";

const rel = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  app_id: "app-1",
  version: "1.5.0",
  kind: "release",
  branch: "main",
  pr: null,
  run: 120,
  commit: "abc",
  notes: null,
  customer_notes: null,
  image_ref: "cr.vetra.io/acme/shop:1.5.0",
  image_digest: `sha256:${"d".repeat(64)}`,
  host: "cli",
  packages: "[]",
  requires: "{}",
  migrates: false,
  powerhouse_version: "6.2.3",
  base_image: "node:24",
  created_at: "2026-11-12T00:00:00.000Z",
  withdrawn_at: null,
  withdrawn_by: null,
  withdrawn_reason: null,
  ...over,
});
const pro = { slug: "pro", size: "VETRA_AGENT_M", access: "own" as const };

describe("rollout checks (spec 7 step 1, 14.3)", () => {
  it("a target is a recorded, unwithdrawn release", () => {
    expect(releaseProblem("9.9.9", null)).toMatch(/no release 9.9.9/);
    expect(releaseProblem("1.5.0-main.3", rel({ kind: "build" }))).toMatch(
      /build/,
    );
    expect(
      releaseProblem(
        "1.5.0",
        rel({ withdrawn_at: "2026-11-12T00:00:00.000Z" }),
      ),
    ).toMatch(/withdrawn/);
    expect(releaseProblem("1.5.0", rel())).toBeNull();
  });

  it("requires: no extra services, a size the plan has; the licence gate only for shared plans once set", () => {
    expect(
      planFitProblem(rel({ requires: '{"services":["DOCLING"]}' }), pro),
    ).toMatch(/DOCLING/);
    expect(planFitProblem(rel({ requires: '{"size":"L"}' }), pro)).toMatch(
      /size L/,
    );
    expect(
      planFitProblem(rel({ requires: '{"size":"VETRA_AGENT_M"}' }), pro),
    ).toBeNull();
    expect(
      planFitProblem(
        rel({ requires: '{"size":"S","powerhouse":">=6.2.3"}' }),
        pro,
      ),
    ).toBeNull();
    expect(planFitProblem(rel({ requires: '{"size":"huge"}' }), pro)).toMatch(
      /does not know/,
    );
    expect(
      planFitProblem(
        rel({ powerhouse_version: "6.2.3" }),
        { ...pro, access: "shared" },
        "6.3.0",
      ),
    ).toMatch(/licence gate/);
    expect(
      planFitProblem(rel({ powerhouse_version: "6.2.3" }), pro, "6.3.0"),
    ).toBeNull();
    expect(powerhouseAtLeast("6.3.0-dev.152", "6.3.0")).toBe(true);
    expect(powerhouseAtLeast("6.2.9", "6.3.0")).toBe(false);
  });

  it("refuses a release whose requires cannot be read, rather than reading it as no requirements", () => {
    for (const requires of [
      "{not json",
      "[]",
      '"S"',
      '{"services":"DOCLING"}',
      '{"services":[1]}',
      '{"size":3}',
      '{"powerhouse":6}',
    ])
      expect(planFitProblem(rel({ requires }), pro)).toMatch(
        /1.5.0's requires cannot be read/,
      );
    expect(planFitProblem(rel({ requires: "null" }), pro)).toBeNull();
  });
});
