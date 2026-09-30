import { describe, it, expect } from "vitest";
import { getTenantId } from "./gitops.js";

// The tenant id is the namespace, the ArgoCD Application name and the tenant
// repo dir, so it must be a lowercase RFC 1123 label.
const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe("getTenantId", () => {
  it("lowercases mixed-case document ids (newer reactor id format)", () => {
    const id = getTenantId("vast-vole-351c8164", "8tgXdfJjQ2mZpL0aBcDe");
    expect(id).toBe("vast-vole-351c8164-8tgxdfjj");
    expect(id).toMatch(RFC1123);
  });

  it("keeps existing uuid-based tenant ids unchanged", () => {
    expect(
      getTenantId("noble-fox-31bf9f74", "31bf9f74-1111-2222-3333-444455556666"),
    ).toBe("noble-fox-31bf9f74-31bf9f74");
  });
});
