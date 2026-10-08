import { describe, expect, it } from "vitest";
import { createResolvers } from "../resolvers.js";
import { createPublisherResolvers } from "../publisher-resolvers.js";
import { mergeResolvers } from "../merge-resolvers.js";

describe("mergeResolvers", () => {
  const machine = createResolvers({
    cfg: { enabled: true },
  } as never) as Record<string, Record<string, unknown>>;
  const publisher = createPublisherResolvers({
    cfg: { enabled: true },
  } as never) as Record<string, Record<string, unknown>>;

  it("keeps both namespaces on Query and Mutation", () => {
    const m = mergeResolvers(machine, publisher);
    expect(Object.keys(m.Query)).toEqual(
      expect.arrayContaining(["vetraLicensing", "vetraPublisher"]),
    );
    expect(Object.keys(m.Mutation)).toEqual(
      expect.arrayContaining(["vetraLicensing", "vetraPublisher"]),
    );
  });

  it("keeps every namespaced resolver group from both sides", () => {
    const m = mergeResolvers(machine, publisher);
    for (const k of [...Object.keys(machine), ...Object.keys(publisher)]) {
      expect(m).toHaveProperty(k);
    }
    expect(m.VetraLicensingQueries).toBe(machine.VetraLicensingQueries);
    expect(m.VetraPublisherQueries).toBe(publisher.VetraPublisherQueries);
  });

  it("throws when both maps define the same non-root key", () => {
    expect(() =>
      mergeResolvers(
        { VetraLicensingQueries: { a: 1 } },
        { VetraLicensingQueries: { b: 2 } },
      ),
    ).toThrow('resolver key "VetraLicensingQueries" is defined by both');
  });
});
