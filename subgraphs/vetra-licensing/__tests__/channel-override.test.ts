import { describe, expect, it } from "vitest";
import { parseAppDocument, resolveKind } from "../app-reads.js";
import { CANARY_CHANNEL, resolveChainKind } from "../channel-override.js";

/** A parsed vetra-app document: a DEDICATED template whose FUSION service follows LATEST. */
function appWith(channels: { channel: string; version: string }[]) {
  const doc = {
    header: { id: "app-1", documentType: "powerhouse/vetra-app" },
    state: {
      global: {
        name: "Sektar",
        status: "ACTIVE",
        templates: [
          {
            id: "t",
            mode: "DEDICATED",
            size: null,
            baseDomain: null,
            packageRegistry: null,
            packages: [],
            services: [
              {
                id: "f",
                type: "FUSION",
                prefix: "sektar",
                artifactName: "host",
                artifactChannel: "LATEST",
              },
            ],
          },
        ],
        terms: [
          {
            id: "k",
            kind: "pro",
            label: "Pro",
            templateId: "t",
            validityDays: null,
            issuers: [],
            status: "ACTIVE",
          },
        ],
        artifacts: [
          {
            kind: "FUSION_IMAGE",
            name: "host",
            versions: [
              {
                version: "1.0.0",
                reference: "cr.vetra.io/app-sektar/host:1.0.0",
              },
              {
                version: "1.1.0",
                reference: "cr.vetra.io/app-sektar/host:1.1.0",
              },
            ],
            channels,
          },
        ],
      },
    },
  };
  const app = parseAppDocument(doc);
  if (!app) throw new Error("fixture did not parse");
  return { ...app, unverified: false };
}
const versionOf = (r: ReturnType<typeof resolveKind>) =>
  r.ok ? r.template.template.services[0]!.resolvedVersion : r.reason;

describe("resolveChainKind", () => {
  const both = appWith([
    { channel: "LATEST", version: "1.0.0" },
    { channel: "STAGING", version: "1.1.0" },
  ]);

  it("is resolveKind for a chain without an override", () => {
    expect(resolveChainKind(both, "pro", null)).toStrictEqual(
      resolveKind(both, "pro"),
    );
  });

  it("resolves a canary on STAGING, with its own hash", () => {
    const canary = resolveChainKind(both, "pro", CANARY_CHANNEL);
    const own = resolveKind(both, "pro");
    expect(versionOf(canary)).toBe("1.1.0");
    expect(versionOf(own)).toBe("1.0.0");
    expect(
      canary.ok &&
        own.ok &&
        canary.template.templateHash !== own.template.templateHash,
    ).toBe(true);
  });

  it("resolves a canary whose app has no LATEST build yet (a gated app's first release)", () => {
    const stagingOnly = appWith([{ channel: "STAGING", version: "1.1.0" }]);
    expect(resolveKind(stagingOnly, "pro").ok).toBe(false);
    expect(
      versionOf(resolveChainKind(stagingOnly, "pro", CANARY_CHANNEL)),
    ).toBe("1.1.0");
  });

  it("holds a canary whose channel has no build", () => {
    const latestOnly = appWith([{ channel: "LATEST", version: "1.0.0" }]);
    const r = resolveChainKind(latestOnly, "pro", CANARY_CHANNEL);
    expect(r).toStrictEqual({
      ok: false,
      reason: expect.stringContaining("has no STAGING build yet"),
    });
  });
});
