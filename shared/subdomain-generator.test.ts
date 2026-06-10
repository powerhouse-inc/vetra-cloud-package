import { describe, expect, it } from "vitest";
import { generateSubdomain } from "./subdomain-generator";

describe("generateSubdomain", () => {
  it("produces adjective-animal-<8hex> from the id", () => {
    const sub = generateSubdomain("fc121815-bddf-4f6b-a708-da052225660b");
    expect(sub).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
    // Suffix matches the first 8 hex chars getTenantId() uses for the
    // namespace, so the ingress host (which uses the subdomain) can't collide.
    expect(sub.endsWith("-fc121815")).toBe(true);
  });

  it("is deterministic for the same id", () => {
    const id = "8745c74e-1111-2222-3333-444455556666";
    expect(generateSubdomain(id)).toBe(generateSubdomain(id));
  });

  it("keeps ids distinct that previously collided on the number suffix", () => {
    const a = generateSubdomain("fc121815-bddf-4f6b-a708-da052225660b");
    const b = generateSubdomain("8745c74e-aaaa-bbbb-cccc-dddddddddddd");
    expect(a).not.toBe(b);
  });

  it("lowercases hex and strips dashes for a DNS-valid label", () => {
    const sub = generateSubdomain("ABCD1234-0000-0000-0000-000000000000");
    expect(sub.endsWith("-abcd1234")).toBe(true);
    expect(sub).toMatch(/^[a-z0-9-]+$/);
  });
});
