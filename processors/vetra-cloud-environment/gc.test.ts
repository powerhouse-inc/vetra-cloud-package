import { describe, it, expect } from "vitest";
import { MANAGED_MARKER, isManagedValues, computeOrphanTenantDirs } from "./gc.js";

describe("isManagedValues", () => {
  it("recognises a values file this processor generated (marker on the first line)", () => {
    expect(isManagedValues(`${MANAGED_MARKER}\nglobal:\n  subdomain: x\n`)).toBe(true);
  });
  it("tolerates leading whitespace/newlines before the marker", () => {
    expect(isManagedValues(`\n${MANAGED_MARKER}\nglobal:\n`)).toBe(true);
  });
  it("does NOT recognise a hand-written / infra tenant (no marker) — protects academy/warm-eel/etc.", () => {
    expect(isManagedValues("global:\n  subdomain: academy\napp:\n  enabled: true\n")).toBe(false);
    expect(isManagedValues("# some other comment\nclint:\n  agents: []\n")).toBe(false);
  });
});

describe("computeOrphanTenantDirs", () => {
  const live = new Set(["keep-a-11111111", "keep-b-22222222"]);

  it("removes managed dirs with no live env doc, keeps those that have one", () => {
    const r = computeOrphanTenantDirs(
      ["keep-a-11111111", "orphan-x-33333333", "keep-b-22222222", "orphan-y-44444444"],
      live,
    );
    expect(r.skippedForSafety).toBe(false);
    expect(r.toRemove.sort()).toEqual(["orphan-x-33333333", "orphan-y-44444444"]);
  });

  it("never returns a dir that has a live env doc", () => {
    const r = computeOrphanTenantDirs(["keep-a-11111111", "keep-b-22222222"], live);
    expect(r.toRemove).toEqual([]);
  });

  it("only ever considers the dirs passed in (caller passes ONLY marker-managed dirs → infra can't be touched)", () => {
    // 'academy' is not in the managed list at all → impossible to return it,
    // regardless of it having no env doc. (Orphan kept under the safety cap.)
    const r = computeOrphanTenantDirs(
      ["keep-a-11111111", "keep-b-22222222", "orphan-x-33333333"],
      live,
    );
    expect(r.toRemove).toEqual(["orphan-x-33333333"]);
    expect(r.toRemove).not.toContain("academy");
  });

  it("CIRCUIT BREAKER: refuses to act if >50% of managed dirs would be removed (guards a bad live-set)", () => {
    // live-set empty (e.g. DB query failed) → would nuke everything → must abort
    const r = computeOrphanTenantDirs(
      ["a-1", "b-2", "c-3", "d-4"],
      new Set<string>(),
    );
    expect(r.skippedForSafety).toBe(true);
    expect(r.toRemove).toEqual([]);
  });

  it("acts normally when removals are under the safety cap", () => {
    const r = computeOrphanTenantDirs(["a-1", "b-2", "c-3", "d-4"], new Set(["a-1", "b-2", "c-3"]));
    expect(r.skippedForSafety).toBe(false);
    expect(r.toRemove).toEqual(["d-4"]);
  });

  it("no managed dirs → nothing to do", () => {
    expect(computeOrphanTenantDirs([], live)).toEqual({ toRemove: [], skippedForSafety: false });
  });
});
