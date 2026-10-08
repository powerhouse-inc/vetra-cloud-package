import { describe, expect, it } from "vitest";
import { createReactorLicenseReads, type LicenseClientLike } from "../reads.js";

const appDoc = (artifacts: unknown) => ({
  header: { id: "app-1", documentType: "powerhouse/vetra-app" },
  state: { global: { name: "dtbau", artifacts } },
});

const client = (doc: unknown): LicenseClientLike => ({
  async find() {
    return { results: [] };
  },
  async get(id: string) {
    if (id !== "app-1") throw new Error(`Document not found: ${id}`);
    if (doc === null) throw new Error("Document not found: app-1");
    return doc;
  },
});

const reads = (doc: unknown) => createReactorLicenseReads(client(doc));

describe("appArtifacts", () => {
  it("reads the app's artifacts, versions newest last", async () => {
    const out = await reads(
      appDoc([
        {
          id: "FUSION_IMAGE:dtbau-psb",
          kind: "FUSION_IMAGE",
          name: "dtbau-psb",
          versions: [
            { version: "1.0.0", reference: "cr.vetra.io/p/dtbau-psb:1.0.0" },
            { version: "1.1.0", reference: "cr.vetra.io/p/dtbau-psb:1.1.0" },
          ],
          channels: [{ channel: "LATEST", version: "1.1.0" }],
        },
      ]),
    ).appArtifacts("app-1");

    expect(out).toStrictEqual([
      {
        kind: "FUSION_IMAGE",
        name: "dtbau-psb",
        versions: [
          { version: "1.0.0", reference: "cr.vetra.io/p/dtbau-psb:1.0.0" },
          { version: "1.1.0", reference: "cr.vetra.io/p/dtbau-psb:1.1.0" },
        ],
        channels: [{ channel: "LATEST", version: "1.1.0" }],
      },
    ]);
  });

  // An app that has never published is the common case on day one. It must read
  // as "nothing yet", not as an error — an empty dropdown is what makes a form
  // feel broken.
  it("returns an empty list when the app has no document", async () => {
    expect(await reads(null).appArtifacts("app-1")).toStrictEqual([]);
  });

  it("returns an empty list when the document has no artifacts", async () => {
    expect(await reads(appDoc([])).appArtifacts("app-1")).toStrictEqual([]);
    expect(await reads(appDoc(undefined)).appArtifacts("app-1")).toStrictEqual(
      [],
    );
  });

  it("skips an entry with an unknown kind or no name", async () => {
    const out = await reads(
      appDoc([
        { kind: "SOMETHING", name: "x", versions: [], channels: [] },
        { kind: "PACKAGE", name: "", versions: [], channels: [] },
        { kind: "PACKAGE", name: "@acme/pkg", versions: [], channels: [] },
      ]),
    ).appArtifacts("app-1");
    expect(out.map((a) => a.name)).toStrictEqual(["@acme/pkg"]);
  });

  it("survives malformed versions and channels rather than throwing", async () => {
    const out = await reads(
      appDoc([
        {
          kind: "PACKAGE",
          name: "@acme/pkg",
          // a version with no reference cannot be run, so it is not offered
          versions: [
            { version: "1.0.0", reference: "https://reg/x" },
            null,
            { nope: true },
            { version: "2.0.0" },
          ],
          channels: [
            { channel: "LATEST" },
            { channel: "DEV", version: "1.0.0" },
          ],
        },
      ]),
    ).appArtifacts("app-1");

    expect(out[0]!.versions).toStrictEqual([
      { version: "1.0.0", reference: "https://reg/x" },
    ]);
    expect(out[0]!.channels).toStrictEqual([
      { channel: "DEV", version: "1.0.0" },
    ]);
  });
});
