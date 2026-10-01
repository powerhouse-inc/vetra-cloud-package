import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setFusionConfig,
} from "document-models/vetra-cloud-environment/v1";

const base = {
  image: "cr.vetra.io/achra/frontend",
  env: [
    { name: "NEXT_PUBLIC_SHOW_WHITELIST_OVERLAY", value: "false", isSecret: false },
    { name: "MAILCHIMP_API_KEY", value: "s3cret", isSecret: true },
  ],
  autoUpdate: true,
  autoUpdateTagPattern: null,
};

describe("SET_FUSION_CONFIG", () => {
  it("stores the fusion config and drops secret values", () => {
    const doc = reducer(utils.createDocument(), setFusionConfig(base));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.fusion).toStrictEqual({
      image: "cr.vetra.io/achra/frontend",
      env: [
        { name: "NEXT_PUBLIC_SHOW_WHITELIST_OVERLAY", value: "false", isSecret: false },
        { name: "MAILCHIMP_API_KEY", value: null, isSecret: true },
      ],
      autoUpdate: true,
      autoUpdateTagPattern: null,
    });
  });

  it("starts as null on a new document", () => {
    expect(utils.createDocument().state.global.fusion ?? null).toBeNull();
  });

  it("rejects images outside cr.vetra.io", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, image: "docker.io/evil/app" }),
    );
    expect(doc.operations.global.at(-1)?.error).toMatch(/cr\.vetra\.io/);
    expect(doc.state.global.fusion ?? null).toBeNull();
  });

  it("rejects an image reference that carries a tag", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, image: "cr.vetra.io/achra/frontend:sha-1" }),
    );
    expect(doc.operations.global.at(-1)?.error).toMatch(/tag/);
  });

  it("rejects an invalid tag pattern", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, autoUpdateTagPattern: "([" }),
    );
    expect(doc.operations.global.at(-1)?.error).toMatch(/pattern/i);
  });

  it("replaces the config on a second call", () => {
    let doc = reducer(utils.createDocument(), setFusionConfig(base));
    doc = reducer(doc, setFusionConfig({ ...base, env: [], autoUpdate: false }));
    expect(doc.state.global.fusion?.env).toStrictEqual([]);
    expect(doc.state.global.fusion?.autoUpdate).toBe(false);
  });

  it("rejects env names that are not plain identifiers (YAML injection)", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({
        ...base,
        env: [{ name: 'X: "1"\n  image:\n    repository: "docker.io/evil/x"', value: "y", isSecret: false }],
      }),
    );
    expect(doc.operations.global.at(-1)?.error).toMatch(/env name/i);
    expect(doc.state.global.fusion ?? null).toBeNull();
  });

  it("rejects secrets with a NEXT_PUBLIC_ name (they would land in browser JS)", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({
        ...base,
        env: [{ name: "NEXT_PUBLIC_API_KEY", value: "k", isSecret: true }],
      }),
    );
    expect(doc.operations.global.at(-1)?.error).toMatch(/NEXT_PUBLIC_/);
  });

  it("rejects catastrophic or oversized tag patterns", () => {
    for (const autoUpdateTagPattern of ["^(a+)+$", "(x*)*", "^" + "a".repeat(120) + "$"]) {
      const doc = reducer(utils.createDocument(), setFusionConfig({ ...base, autoUpdateTagPattern }));
      expect(doc.operations.global.at(-1)?.error).toMatch(/pattern/i);
    }
  });
});
