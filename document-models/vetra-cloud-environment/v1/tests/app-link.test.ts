import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setAppLink,
  clearAppLink,
  setOwner,
  initialize,
  approveChanges,
} from "document-models/vetra-cloud-environment/v1";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

const PREVIEW = {
  appId: "app-1",
  role: "PREVIEW" as const,
  prNumber: 42,
  gitRef: "refs/pull/42/merge",
  imageProject: "app-achra",
};

describe("SET_APP_LINK / CLEAR_APP_LINK", () => {
  it("starts as null on a new document", () => {
    expect(utils.createDocument().state.global.app ?? null).toBeNull();
  });

  it("lets a system action (no user signer) set the link", () => {
    const doc = reducer(utils.createDocument(), setAppLink(PREVIEW));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.app).toStrictEqual(PREVIEW);
  });

  it("normalises omitted optional fields to null", () => {
    const doc = reducer(
      utils.createDocument(),
      setAppLink({ appId: "app-1", role: "PRODUCTION" }),
    );
    expect(doc.state.global.app).toStrictEqual({
      appId: "app-1",
      role: "PRODUCTION",
      prNumber: null,
      gitRef: null,
      imageProject: null,
    });
  });

  it("rejects a user-signed SET_APP_LINK, even from the owner", () => {
    let doc = reducer(utils.createDocument(), {
      ...setOwner({ address: ALICE }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, { ...setAppLink(PREVIEW), ...userSigner(ALICE) });
    expect(doc.operations.global.at(-1)?.error).toMatch(/AppLinkSystemOnly/);
    expect(doc.state.global.app ?? null).toBeNull();
  });

  it("rejects a user-signed SET_APP_LINK on an unowned env (no auto-claim)", () => {
    const doc = reducer(utils.createDocument(), {
      ...setAppLink(PREVIEW),
      ...userSigner(ALICE),
    });
    expect(doc.operations.global.at(-1)?.error).toMatch(/AppLinkSystemOnly/);
    expect(doc.state.global.owner).toBeNull();
  });

  it("lets a system action clear the link", () => {
    let doc = reducer(utils.createDocument(), setAppLink(PREVIEW));
    doc = reducer(doc, clearAppLink({}));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.app).toBeNull();
  });

  it("rejects a user-signed CLEAR_APP_LINK", () => {
    let doc = reducer(utils.createDocument(), setAppLink(PREVIEW));
    doc = reducer(doc, { ...clearAppLink({}), ...userSigner(ALICE) });
    expect(doc.operations.global.at(-1)?.error).toMatch(/AppLinkSystemOnly/);
    expect(doc.state.global.app).toStrictEqual(PREVIEW);
  });

  it("marks a deployed env CHANGES_PENDING (the link changes the render)", () => {
    let doc = reducer(
      utils.createDocument(),
      initialize({
        genericSubdomain: "x",
        genericBaseDomain: "vetra.io",
        defaultPackageRegistry: null,
      }),
    );
    // CHANGES_APPROVED counts as deployed for markPendingIfDeployed.
    doc = reducer(doc, setAppLink(PREVIEW));
    expect(doc.state.global.status).toBe("CHANGES_PENDING");
    doc = reducer(doc, approveChanges({}));
    doc = reducer(doc, clearAppLink({}));
    expect(doc.state.global.status).toBe("CHANGES_PENDING");
  });

  it("keeps a DRAFT env in DRAFT", () => {
    const doc = reducer(utils.createDocument(), setAppLink(PREVIEW));
    expect(doc.state.global.status).toBe("DRAFT");
  });
});
