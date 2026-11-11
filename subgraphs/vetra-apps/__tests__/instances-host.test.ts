import { describe, expect, it } from "vitest";
import {
  instanceHash,
  instanceLabel,
  InstanceHostError,
  MAX_INSTANCE_LABEL,
} from "../instances/host.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const OLD_PATH = /-(connect|switchboard)(-stg)?$/;

describe("instanceLabel", () => {
  it("is slug-branch-hash, then the staging suffix", () => {
    const h = instanceHash("app-1", "main");
    expect(h).toMatch(/^[0-9a-f]{6}$/);
    expect(instanceLabel("app-1", "shop", "main")).toBe(`shop-main-${h}`);
    expect(instanceLabel("app-1", "shop", "main", "-stg")).toBe(
      `shop-main-${h}-stg`,
    );
  });

  it("is deterministic and depends on app and branch", () => {
    expect(instanceLabel("app-1", "shop", "main")).toBe(
      instanceLabel("app-1", "shop", "main"),
    );
    expect(instanceLabel("app-1", "shop", "main")).not.toBe(
      instanceLabel("app-2", "shop", "main"),
    );
    expect(instanceLabel("app-1", "shop", "release/1.x")).not.toBe(
      instanceLabel("app-1", "shop", "release-1-x"),
    );
    expect(instanceLabel("app-1", "shop", "Feature")).toMatch(
      /^shop-feature-[0-9a-f]{6}$/,
    );
  });

  it("never collides with old-path hosts", () => {
    for (const branch of ["connect", "switchboard"]) {
      for (const suffix of ["", "-stg"]) {
        const label = instanceLabel("app-1", "shop", branch, suffix);
        expect(label).not.toBe(`shop-${branch}${suffix}`);
        expect(label).not.toMatch(OLD_PATH);
      }
    }
  });

  it("keeps a branch named like another's staging form apart", () => {
    const stagingOfMain = instanceLabel("app-1", "shop", "main", "-stg");
    expect(instanceLabel("app-1", "shop", "main-stg")).not.toBe(stagingOfMain);
    expect(instanceLabel("app-1", "shop", "main-stg", "-stg")).not.toBe(
      stagingOfMain,
    );
  });

  it("keeps a + b-c and a-b + c apart across apps", () => {
    expect(instanceLabel("app-1", "a", "b-c")).not.toBe(
      instanceLabel("app-2", "a-b", "c"),
    );
  });

  it("truncates only slug and branch parts, to exactly the budget at the boundary", () => {
    const M = MAX_INSTANCE_LABEL;
    const h = instanceHash("app-1", "b".repeat(40));
    const label = instanceLabel("app-1", "s".repeat(40), "b".repeat(40));
    expect(label).toHaveLength(M);
    expect(label.endsWith(`-${h}`)).toBe(true);
    const stg = instanceLabel("app-1", "s".repeat(40), "b".repeat(40), "-stg");
    expect(stg).toHaveLength(M);
    expect(stg.endsWith(`-${h}-stg`)).toBe(true);
    // Fits without truncation at exactly M: 12 + 1 + 11 + 7.
    const exact = instanceLabel("app-1", "s".repeat(12), "b".repeat(11));
    expect(exact).toHaveLength(M);
    expect(exact.startsWith(`${"s".repeat(12)}-${"b".repeat(11)}-`)).toBe(true);
    // One more character is truncated, not rejected.
    expect(instanceLabel("app-1", "s".repeat(12), "b".repeat(12))).toHaveLength(
      M,
    );
  });

  it("gives long branches distinct labels", () => {
    const long = "a".repeat(80);
    expect(instanceLabel("app-1", "shop", long, "-stg")).not.toBe(
      instanceLabel("app-1", "shop", `${long}b`, "-stg"),
    );
  });

  it("always yields a valid DNS label for odd input", () => {
    const names = [
      "---",
      "/",
      "é",
      "-x-",
      "a..b",
      "x".repeat(200),
      "feat/" + "y-".repeat(40),
    ];
    for (const slug of ["shop", "s".repeat(60), "---"]) {
      for (const name of names) {
        for (const suffix of ["", "-stg"]) {
          const label = instanceLabel("app-1", slug, name, suffix);
          expect(label).toMatch(LABEL);
          expect(label.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
          expect(label.endsWith(suffix)).toBe(true);
        }
      }
    }
  });

  it("refuses an absurd suffix", () => {
    expect(() =>
      instanceLabel("app-1", "shop", "main", "-".padEnd(60, "x")),
    ).toThrow(InstanceHostError);
  });
});

describe("instanceLabel length budget", () => {
  const DOC_ID = "XmkP6hLz_9aBcDeF";
  const long = "vetra-publish-canary-with-a-very-long-slug-name";
  const branches = ["main", "feature/some-really-long-branch-name-here", "x"];
  for (const suffix of ["", "-stg"])
    for (const slug of ["shop", long])
      for (const branch of branches)
        it(`fits every derived name: ${slug.length}/${branch.length} "${suffix}"`, () => {
          const label = instanceLabel("app-1", slug, branch, suffix);
          const h = instanceHash("app-1", branch);
          expect(label).toContain(`-${h}`);
          expect(label.endsWith(`${h}${suffix}`)).toBe(true);
          expect(label.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
          // getTenantId is the processor's own formula: `<label>-<8 doc chars>`.
          const tenant = getTenantId(label, DOC_ID);
          const release = `powerhouse-${tenant}`;
          expect(release.length).toBeLessThanOrEqual(53); // Helm release name
          expect(tenant.length).toBeLessThanOrEqual(63); // namespace
          expect(`${release}-switchboard`.length).toBeLessThanOrEqual(63);
          expect(`${release}-connect`.length).toBeLessThanOrEqual(63);
          expect(`${label}-switchboard`.length).toBeLessThanOrEqual(63);
          expect(`${label}-connect`.length).toBeLessThanOrEqual(63);
          expect(label).toMatch(LABEL);
        });

  it("leaves labels that already fit unchanged", () => {
    const h = instanceHash("app-1", "main");
    expect(instanceLabel("app-1", "shop", "main", "-stg")).toBe(
      `shop-main-${h}-stg`,
    );
    expect(instanceLabel("app-1", "vetra-publish", "main")).toBe(
      `vetra-publish-main-${h}`,
    );
  });

  it("reproduces the staging failure case within budget", () => {
    const label = instanceLabel("a", "vetra-publish-canary", "main", "-stg");
    expect(`powerhouse-${getTenantId(label, "xmkp6hlz")}`.length).toBeLessThanOrEqual(53);
  });
});
