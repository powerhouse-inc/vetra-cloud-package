import { describe, expect, it, vi } from "vitest";
import { createAppIdentityLookup } from "../app-identity.js";
import type { AppDocView } from "../app-reads.js";
import { STUDIO_APP_ID } from "../studio-app.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER = "did:key:zOther";
const APP = "7c1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a44";

function view(extra: Partial<AppDocView> = {}): AppDocView {
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

function setup(
  row: { identity_did: string | null; status: string } | null,
  studioIdentityDid: string | null = DID,
) {
  const rowFn = vi.fn(async (_id: string) => row);
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { rowFn, logger, identityOf: createAppIdentityLookup({ row: rowFn, studioIdentityDid, logger }) };
}

describe("createAppIdentityLookup", () => {
  it("uses the apps row whenever there is one", async () => {
    const { rowFn, logger, identityOf } = setup({ identity_did: "did:key:zRow", status: "DISCONNECTED" });
    expect(await identityOf(STUDIO_APP_ID, view())).toEqual({ identityDid: "did:key:zRow", status: "DISCONNECTED" });
    expect(await identityOf(APP)).toEqual({ identityDid: "did:key:zRow", status: "DISCONNECTED" });
    expect(rowFn).toHaveBeenCalledWith(STUDIO_APP_ID);
    expect(rowFn).toHaveBeenCalledWith(APP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("knows no other row-less app", async () => {
    const { rowFn, identityOf } = setup(null);
    expect(await identityOf(APP, view({ id: APP }))).toBeNull();
    expect(rowFn).toHaveBeenCalledWith(APP);
  });

  it("gives the row-less studio app its configured identity as ACTIVE", async () => {
    const { rowFn, logger, identityOf } = setup(null);
    expect(await identityOf(STUDIO_APP_ID, view())).toEqual({ identityDid: DID, status: "ACTIVE" });
    expect(rowFn).toHaveBeenCalledWith(STUDIO_APP_ID);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not relay studio stats when unconfigured, and logs once", async () => {
    const { logger, identityOf } = setup(null, null);
    expect(await identityOf(STUDIO_APP_ID, view())).toBeNull();
    expect(await identityOf(STUDIO_APP_ID, view())).toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("VETRA_STUDIO_IDENTITY_DID unset"));
  });

  it("uses the configured identity even when the document says otherwise, warning once", async () => {
    const { logger, identityOf } = setup(null);
    const doc = view({ identityDid: OTHER, status: "DISCONNECTED" });
    expect(await identityOf(STUDIO_APP_ID, doc)).toEqual({ identityDid: DID, status: "ACTIVE" });
    expect(await identityOf(STUDIO_APP_ID, doc)).toEqual({ identityDid: DID, status: "ACTIVE" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tampered", view({ tampered: true, tamperReason: "parent" })],
    ["unverified", view({ unverified: true })],
  ])("warns about a %s document but still uses the configured identity", async (_, doc) => {
    const { logger, identityOf } = setup(null);
    expect(await identityOf(STUDIO_APP_ID, doc)).toEqual({ identityDid: DID, status: "ACTIVE" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([["no document", null], ["no document view passed", undefined], ["a document without an identity", view({ identityDid: null })]])(
    "uses the configured identity with %s, without warning",
    async (_, doc) => {
      const { logger, identityOf } = setup(null);
      expect(await identityOf(STUDIO_APP_ID, doc)).toEqual({ identityDid: DID, status: "ACTIVE" });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});
