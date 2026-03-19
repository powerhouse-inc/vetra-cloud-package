import { describe, it, expect } from "vitest";
import { generateSubdomain } from "./subdomain-generator.js";

describe("Subdomain Generator", () => {
  it("should produce a deterministic result for the same ID", () => {
    const id = "8ed88516-8f99-4595-a899-171d3f2a24cf";
    const result1 = generateSubdomain(id);
    const result2 = generateSubdomain(id);
    expect(result1).toBe(result2);
  });

  it("should match adjective-animal-NN format", () => {
    const id = "8ed88516-8f99-4595-a899-171d3f2a24cf";
    const result = generateSubdomain(id);
    expect(result).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });

  it("should produce different subdomains for different IDs", () => {
    const id1 = "8ed88516-8f99-4595-a899-171d3f2a24cf";
    const id2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id3 = "11111111-2222-3333-4444-555555555555";
    const results = new Set([
      generateSubdomain(id1),
      generateSubdomain(id2),
      generateSubdomain(id3),
    ]);
    expect(results.size).toBe(3);
  });

  it("should handle a zero-filled UUID", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const result = generateSubdomain(id);
    expect(result).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });
});
