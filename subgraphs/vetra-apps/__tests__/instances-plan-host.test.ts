import { describe, expect, it } from "vitest";
import {
  instanceLabel,
  MAX_INSTANCE_LABEL,
  planInstanceLabel,
} from "../instances/host.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";

const app = { id: "app-1", slug: "sektar" };

describe("plan instance hosts", () => {
  it("keeps branch labels as they were", () => {
    expect(instanceLabel("app-1", "sektar", "main", "-stg", "main")).toBe(
      instanceLabel("app-1", "sektar", "main", "-stg"),
    );
  });
  it("never gives a shared plan the label of a branch with the same name", () => {
    const shared = planInstanceLabel(
      app,
      { id: "i1", kind: "shared", name: "starter" },
      "",
    );
    expect(shared.startsWith("sektar-starter-")).toBe(true);
    expect(shared).not.toBe(instanceLabel("app-1", "sektar", "starter"));
  });
  it("gives an own instance a generated name with the suffix, else a hashed fallback", () => {
    const id = "3f2a9c1e-0000-4000-8000-000000000000";
    const own = planInstanceLabel(
      app,
      { id, kind: "own", name: "own-x", licence_root_id: "root-1" },
      "-stg",
    );
    const generated = `${generateSubdomain(id)}-stg`;
    expect(own).toBe(generated.length <= MAX_INSTANCE_LABEL ? generated : own);
    expect(own.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
    const tight = planInstanceLabel(
      app,
      { id, kind: "own", name: "own-x", licence_root_id: "root-1" },
      "-abcdefg",
    );
    expect(tight.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
  });
});
