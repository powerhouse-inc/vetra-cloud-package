import { describe, expect, it } from "vitest";
import { tenantConfigEntries } from "./gitops.js";

const clint = (over: Record<string, unknown>) => ({
  type: "CLINT",
  enabled: true,
  prefix: "agent",
  config: {
    package: { registry: "r", name: "p", version: "1" },
    env: [] as Array<{ name: string; value?: string | null; isSecret?: boolean | null }>,
  },
  ...over,
});

describe("tenantConfigEntries", () => {
  it("lists the env entries of enabled CLINT services with a package, classified like the render", () => {
    const state = {
      services: [
        clint({
          config: {
            package: { registry: "r", name: "p", version: "1" },
            env: [
              { name: "VETRA_REQUIRE_API_KEY", value: "true", isSecret: false },
              { name: "API_TOKEN", value: "s3cret", isSecret: true },
              { name: "EMPTY_TOKEN", value: "", isSecret: true },
              { name: "NULL_VALUE", value: null, isSecret: false },
            ],
          },
        }),
        clint({ enabled: false, config: { package: { registry: "r", name: "p", version: "1" }, env: [{ name: "OFF", value: "1" }] } }),
        clint({ config: { package: null, env: [{ name: "NOPKG", value: "1" }] } }),
        { type: "SWITCHBOARD", enabled: true, prefix: "sb", config: null },
      ],
    };
    expect(tenantConfigEntries(state as never)).toStrictEqual([
      { key: "VETRA_REQUIRE_API_KEY", value: "true", secret: false },
      { key: "API_TOKEN", value: "s3cret", secret: true },
      { key: "NULL_VALUE", value: "", secret: false },
    ]);
  });

  it("is empty for a document without services", () => {
    expect(tenantConfigEntries({ services: [] } as never)).toStrictEqual([]);
  });
});
