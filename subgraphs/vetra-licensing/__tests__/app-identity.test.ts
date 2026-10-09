import { describe, expect, it, vi } from "vitest";
import { createAppIdentityLookup } from "../app-identity.js";
import type { AppDocView } from "../app-reads.js";
import { STUDIO_APP_ID } from "../studio-app.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const APP = "7c1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a44";

function studioDoc(extra: Partial<AppDocView> = {}): AppDocView {
  return {
    id: STUDIO_APP_ID,
    name: "Vetra Studio",
    slug: "vetra-studio",
    owner: null,
    status: "ACTIVE",
    identityDid: DID,
    productionEnvironmentId: null,
    templates: [],
    terms: [],
    artifacts: [],
    tampered: false,
    tamperReason: null,
    licensingStateHash: "hash",
    unverified: false,
    ...extra,
  };
}

function lookup(row: { identity_did: string | null; status: string } | null, doc: AppDocView | null) {
  const apps = { app: vi.fn(async () => doc) };
  return { apps, identityOf: createAppIdentityLookup({ row: async () => row, apps }) };
}

describe("createAppIdentityLookup", () => {
  it("uses the apps row whenever there is one", async () => {
    const { apps, identityOf } = lookup({ identity_did: "did:key:zRow", status: "DISCONNECTED" }, studioDoc());
    expect(await identityOf(STUDIO_APP_ID)).toEqual({ identityDid: "did:key:zRow", status: "DISCONNECTED" });
    expect(await identityOf(APP)).toEqual({ identityDid: "did:key:zRow", status: "DISCONNECTED" });
    expect(apps.app).not.toHaveBeenCalled();
  });

  it("knows no other document-only app", async () => {
    const { apps, identityOf } = lookup(null, studioDoc());
    expect(await identityOf(APP)).toBeNull();
    expect(apps.app).not.toHaveBeenCalled();
  });

  it("reads the studio app's identity from its ledger-checked document", async () => {
    expect(await lookup(null, studioDoc()).identityOf(STUDIO_APP_ID)).toEqual({ identityDid: DID, status: "ACTIVE" });
  });

  it.each([
    ["a tampered document", studioDoc({ tampered: true, tamperReason: "parent" })],
    ["an unverified document", studioDoc({ unverified: true })],
    ["a document without an identity", studioDoc({ identityDid: null })],
    ["no document", null],
  ])("refuses the studio app with %s", async (_, doc) => {
    expect(await lookup(null, doc).identityOf(STUDIO_APP_ID)).toBeNull();
  });
});
