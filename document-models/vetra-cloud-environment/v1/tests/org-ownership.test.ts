import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setOwner,
  setOwnerOrg,
  syncOrgOperators,
  setLabel,
} from "document-models/vetra-cloud-environment/v1";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ORG = "org-acme";

const signedBy = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});
const lastError = (doc: { operations: { global?: { error?: string }[] } }) =>
  doc.operations.global?.at(-1)?.error;

/** An env owned by OWNER (system claim), optionally handed to ORG by the system. */
function ownedEnv(org?: { operators: string[] }) {
  let doc = reducer(utils.createDocument(), setOwner({ address: OWNER }));
  if (org) doc = reducer(doc, setOwnerOrg({ ownerOrgId: ORG, operators: org.operators }));
  return doc;
}

describe("organisation ownership", () => {
  it("starts personal", () => {
    const s = utils.createDocument().state.global;
    expect(s.ownerOrgId ?? null).toBeNull();
    expect(s.orgOperators).toStrictEqual([]);
  });

  it("lets the system hand an env to an org, normalising operators, and clear it again", () => {
    let doc = ownedEnv({ operators: [BOB.toUpperCase().replace("0X", "0x"), BOB, CAROL] });
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.ownerOrgId).toBe(ORG);
    expect(doc.state.global.orgOperators).toStrictEqual([BOB, CAROL]);
    doc = reducer(doc, setOwnerOrg({ ownerOrgId: null, operators: [BOB] }));
    expect(doc.state.global.ownerOrgId).toBeNull();
    expect(doc.state.global.orgOperators).toStrictEqual([]);
  });

  it("lets the owner hand a personal env over; the owner becomes the only operator", () => {
    const doc = reducer(ownedEnv(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [BOB, CAROL] }), ...signedBy(OWNER) });
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.orgOperators).toStrictEqual([OWNER]);
    expect(doc.state.global.status).toBe("DRAFT");
  });

  it("refuses a hand-over by a non-owner or on an unowned env", () => {
    let doc = reducer(ownedEnv(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [] }), ...signedBy(BOB) });
    expect(lastError(doc)).toMatch(/current owner/);
    expect(doc.state.global.ownerOrgId ?? null).toBeNull();
    doc = reducer(utils.createDocument(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [] }), ...signedBy(BOB) });
    expect(lastError(doc)).toMatch(/current owner/);
    expect(doc.state.global.owner).toBeNull();
  });

  it("refuses the creator once the env belongs to an org (no re-pointing, no clearing)", () => {
    for (const ownerOrgId of ["org-other", null]) {
      const doc = reducer(ownedEnv({ operators: [BOB] }), { ...setOwnerOrg({ ownerOrgId, operators: [OWNER] }), ...signedBy(OWNER) });
      expect(lastError(doc)).toMatch(/only through Vetra/);
      expect(doc.state.global.ownerOrgId).toBe(ORG);
    }
  });

  it("syncs operators from the system only, and only on org envs", () => {
    let doc = reducer(ownedEnv({ operators: [BOB] }), syncOrgOperators({ operators: [CAROL, CAROL] }));
    expect(doc.state.global.orgOperators).toStrictEqual([CAROL]);
    doc = reducer(doc, { ...syncOrgOperators({ operators: [OWNER] }), ...signedBy(CAROL) });
    expect(lastError(doc)).toMatch(/OrgSyncSystemOnly/);
    expect(doc.state.global.orgOperators).toStrictEqual([CAROL]);
    doc = reducer(ownedEnv(), syncOrgOperators({ operators: [BOB] }));
    expect(lastError(doc)).toMatch(/does not belong to an organisation/);
  });

  it("lets operators sign, refuses everyone else including the creator, and lets the system through", () => {
    let doc = reducer(ownedEnv({ operators: [BOB] }), { ...setLabel({ label: "by bob" }), ...signedBy(BOB) });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, { ...setLabel({ label: "by owner" }), ...signedBy(OWNER) });
    expect(lastError(doc)).toMatch(/not an operator/);
    doc = reducer(doc, { ...setLabel({ label: "by carol" }), ...signedBy(CAROL) });
    expect(lastError(doc)).toMatch(/not an operator/);
    doc = reducer(doc, setLabel({ label: "by system" }));
    expect(doc.state.global.label).toBe("by system");
  });

  it("treats a missing operator list as empty (legacy replay)", () => {
    const doc = ownedEnv({ operators: [BOB] });
    delete (doc.state.global as unknown as Record<string, unknown>).orgOperators;
    const next = reducer(doc, { ...setLabel({ label: "x" }), ...signedBy(BOB) });
    expect(lastError(next)).toMatch(/not an operator/);
  });

  it("lets the system transfer an owned env, but not a user on an org env", () => {
    let doc = reducer(ownedEnv(), setOwner({ address: BOB }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.owner).toBe(BOB);
    doc = reducer(ownedEnv({ operators: [OWNER] }), { ...setOwner({ address: CAROL }), ...signedBy(OWNER) });
    expect(lastError(doc)).toMatch(/changes through Vetra/);
    expect(doc.state.global.owner).toBe(OWNER);
  });
});
