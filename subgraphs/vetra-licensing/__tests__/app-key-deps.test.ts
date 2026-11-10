import { describe, it, expect, vi, afterEach } from "vitest";
import { VetraLicensingSubgraph } from "../index.js";

type AppKeyDeps = (
  transit: unknown,
  secrets: unknown,
  studio: unknown,
  db: unknown,
) => Promise<Record<string, unknown>>;

/** The subgraph without its BaseSubgraph constructor: only appKeyDeps is used. */
function subgraph(createNamespace: () => Promise<unknown>): { appKeyDeps: AppKeyDeps } {
  const s = Object.create(VetraLicensingSubgraph.prototype) as Record<string, unknown>;
  s.relationalDb = { createNamespace };
  return s as unknown as { appKeyDeps: AppKeyDeps };
}

describe("VetraLicensingSubgraph.appKeyDeps (the optional included AI key)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to keyless, with a warning, when the vetra-llm setup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = subgraph(async () => {
      throw new Error("namespace failed for Bearer abc.def");
    });
    await expect(s.appKeyDeps.call(s, {}, {}, {}, {})).resolves.toEqual({});
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[licensing] included AI key unavailable");
    expect(logged).toContain("namespace failed");
    expect(logged).not.toContain("abc.def");
  });

  it("stays keyless without transit or secrets, never touching vetra-llm", async () => {
    const createNamespace = vi.fn(async () => ({}));
    const s = subgraph(createNamespace);
    await expect(s.appKeyDeps.call(s, null, {}, {}, {})).resolves.toEqual({});
    expect(createNamespace).not.toHaveBeenCalled();
  });
});
