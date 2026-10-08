import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  addPackage,
  removePackage,
  setPackageVersion,
  setServiceConfig,
  setFusionConfig,
  setDnsRecords,
  setRuntimeConfig,
  enableService,
} from "document-models/vetra-cloud-environment/v1";

const lastError = (doc: { operations: Record<string, { error?: string }[]> }) =>
  doc.operations.global?.at(-1)?.error;

const pkg = { registry: "https://r", name: "p" };

describe("scenario: packages edge cases", () => {
  it("handles a duplicate add, an empty remove and a missing package", () => {
    let doc = reducer(utils.createDocument(), addPackage({ packageName: "a" }));
    // Same package re-added without a registry keeps the existing registry.
    doc = reducer(doc, addPackage({ packageName: "a", version: "2.0.0" }));
    expect(doc.state.global.packages).toStrictEqual([
      { registry: "", name: "a", version: "2.0.0" },
    ]);
    doc = reducer(doc, removePackage({ packageName: "" }));
    expect(doc.state.global.packages).toHaveLength(1);
    doc = reducer(doc, setPackageVersion({ packageName: "zzz", version: "1" }));
    expect(lastError(doc)).toMatch(/not found/);
    doc = reducer(doc, removePackage({ packageName: "a" }));
    expect(doc.state.global.packages).toHaveLength(0);
  });
});

describe("scenario: env normalisation with omitted optional fields", () => {
  it("setServiceConfig / setFusionConfig default env, values and flags", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({
        type: "CLINT",
        prefix: "a",
        clintConfig: { package: pkg, env: [] },
      }),
    );
    doc = reducer(
      doc,
      setServiceConfig({
        prefix: "a",
        config: { package: pkg, env: [{ name: "BARE" }] },
      }),
    );
    expect(doc.state.global.services[0].config?.env).toStrictEqual([
      { name: "BARE", value: null, isSecret: null },
    ]);

    doc = reducer(
      doc,
      setFusionConfig({ autoUpdate: false, env: [{ name: "BARE" }] }),
    );
    expect(doc.state.global.fusion?.env).toStrictEqual([
      { name: "BARE", value: null, isSecret: null },
    ]);
  });
});

describe("scenario: documents without a custom domain", () => {
  it("setDnsRecords creates the custom domain when it is null", () => {
    const base = utils.createDocument();
    const doc = reducer(
      { ...base, state: { ...base.state, global: { ...base.state.global, customDomain: null } } },
      setDnsRecords({ records: [] }),
    );
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.customDomain).toStrictEqual({
      enabled: false,
      domain: null,
      dnsRecords: [],
    });
  });
});

describe("scenario: runtime config validation issues", () => {
  it("reports the root path for a non-object config", () => {
    const doc = reducer(
      utils.createDocument(),
      setRuntimeConfig({ config: JSON.stringify("nope") }),
    );
    expect(lastError(doc)).toMatch(/\//);
  });
});
