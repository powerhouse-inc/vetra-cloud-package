import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setManagedBy,
  setOwner,
  enableService,
  disableService,
  toggleService,
  setServiceVersion,
  setFusionConfig,
} from "document-models/vetra-cloud-environment/v1";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE = "cr.vetra.io/app-sektar/host";

const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

const MANAGED = {
  appId: "app-1",
  templateId: "t-1",
  rootLicenseId: "l-1",
  services: ["FUSION" as const],
};

/** Alice's environment, FUSION enabled at sha-a, CONNECT disabled, managed by app-1's template (FUSION only). */
function managed() {
  let doc = reducer(utils.createDocument(), {
    ...setOwner({ address: ALICE }),
    ...userSigner(ALICE),
  });
  doc = reducer(doc, enableService({ type: "FUSION", prefix: "sektar" }));
  doc = reducer(doc, enableService({ type: "CONNECT", prefix: "connect" }));
  doc = reducer(doc, disableService({ type: "CONNECT", prefix: "connect" }));
  doc = reducer(doc, setServiceVersion({ type: "FUSION", version: "sha-a" }));
  doc = reducer(
    doc,
    setFusionConfig({
      image: IMAGE,
      env: [],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
  );
  doc = reducer(doc, setManagedBy(MANAGED));
  return doc;
}
const lastError = (doc: ReturnType<typeof managed>) =>
  doc.operations.global.at(-1)?.error;
const fusion = (doc: ReturnType<typeof managed>) =>
  doc.state.global.services.find((s) => s.type === "FUSION")!;

describe("SET_MANAGED_BY", () => {
  it("starts as null on a new document", () => {
    expect(utils.createDocument().state.global.managedBy ?? null).toBeNull();
  });

  it("lets a system action set it, and does not move a deployed env to CHANGES_PENDING", () => {
    const doc = managed();
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.managedBy).toStrictEqual(MANAGED);
    const status = doc.state.global.status;
    const again = reducer(doc, setManagedBy({ ...MANAGED, templateId: "t-2" }));
    expect(again.state.global.managedBy).toStrictEqual({
      ...MANAGED,
      templateId: "t-2",
    });
    expect(again.state.global.status).toBe(status);
  });

  it("rejects a user-signed SET_MANAGED_BY, even from the owner", () => {
    const doc = reducer(utils.createDocument(), {
      ...setOwner({ address: ALICE }),
      ...userSigner(ALICE),
    });
    const out = reducer(doc, {
      ...setManagedBy(MANAGED),
      ...userSigner(ALICE),
    });
    expect(lastError(out)).toMatch(/AppLinkSystemOnly: SET_MANAGED_BY/);
    expect(out.state.global.managedBy ?? null).toBeNull();
  });
});

describe("the template lock on a managed environment", () => {
  it("rejects the owner's SET_SERVICE_VERSION of a declared service; a system action passes", () => {
    const signed = reducer(managed(), {
      ...setServiceVersion({ type: "FUSION", version: "sha-old" }),
      ...userSigner(ALICE),
    });
    expect(lastError(signed)).toMatch(/ManagedByTemplate: the FUSION version/);
    expect(fusion(signed).version).toBe("sha-a");
    const system = reducer(
      managed(),
      setServiceVersion({ type: "FUSION", version: "sha-b" }),
    );
    expect(lastError(system)).toBeUndefined();
    expect(fusion(system).version).toBe("sha-b");
  });

  it("rejects disabling or toggling a declared service, and enabling one that is off", () => {
    const disabled = reducer(managed(), {
      ...disableService({ type: "FUSION", prefix: "sektar" }),
      ...userSigner(ALICE),
    });
    expect(lastError(disabled)).toMatch(/ManagedByTemplate: disabling FUSION/);
    expect(fusion(disabled).enabled).toBe(true);
    const toggled = reducer(managed(), {
      ...toggleService({ type: "FUSION" }),
      ...userSigner(ALICE),
    });
    expect(lastError(toggled)).toMatch(/ManagedByTemplate: toggling FUSION/);
    let off = reducer(
      managed(),
      disableService({ type: "FUSION", prefix: "sektar" }),
    );
    off = reducer(off, {
      ...enableService({ type: "FUSION", prefix: "sektar" }),
      ...userSigner(ALICE),
    });
    expect(lastError(off)).toMatch(/ManagedByTemplate: enabling FUSION/);
    expect(fusion(off).enabled).toBe(false);
  });

  it("lets the owner re-state an enabled declared service (a size or prefix change)", () => {
    const doc = reducer(managed(), {
      ...enableService({
        type: "FUSION",
        prefix: "sektar",
        selectedRessource: "VETRA_AGENT_L",
      }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
    expect(fusion(doc).selectedRessource).toBe("VETRA_AGENT_L");
  });

  it("leaves services the template does not declare to the owner", () => {
    let doc = reducer(managed(), {
      ...enableService({ type: "CONNECT", prefix: "connect" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, {
      ...setServiceVersion({ type: "CONNECT", version: "v6" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, {
      ...toggleService({ type: "CONNECT" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, {
      ...disableService({ type: "CONNECT", prefix: "connect" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
  });

  it("rejects a SET_FUSION_CONFIG that changes the image or auto-update, but not one that only changes env", () => {
    const image = reducer(managed(), {
      ...setFusionConfig({
        image: "cr.vetra.io/other/app",
        env: [],
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
      ...userSigner(ALICE),
    });
    expect(lastError(image)).toMatch(
      /ManagedByTemplate: the FUSION image and auto-update/,
    );
    const auto = reducer(managed(), {
      ...setFusionConfig({
        image: IMAGE,
        env: [],
        autoUpdate: true,
        autoUpdateTagPattern: null,
      }),
      ...userSigner(ALICE),
    });
    expect(lastError(auto)).toMatch(/ManagedByTemplate/);
    const pattern = reducer(managed(), {
      ...setFusionConfig({
        image: IMAGE,
        env: [],
        autoUpdate: false,
        autoUpdateTagPattern: "^v",
      }),
      ...userSigner(ALICE),
    });
    expect(lastError(pattern)).toMatch(/ManagedByTemplate/);
    const env = reducer(managed(), {
      ...setFusionConfig({
        image: IMAGE,
        env: [{ name: "FOO", value: "1", isSecret: false }],
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
      ...userSigner(ALICE),
    });
    expect(lastError(env)).toBeUndefined();
    expect(env.state.global.fusion!.env).toStrictEqual([
      { name: "FOO", value: "1", isSecret: false },
    ]);
  });

  it("does not lock an environment no template manages", () => {
    let doc = reducer(utils.createDocument(), {
      ...setOwner({ address: ALICE }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, {
      ...enableService({ type: "FUSION", prefix: "sektar" }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, {
      ...setServiceVersion({ type: "FUSION", version: "sha-x" }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, {
      ...setFusionConfig({
        image: IMAGE,
        env: [],
        autoUpdate: true,
        autoUpdateTagPattern: null,
      }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, {
      ...toggleService({ type: "FUSION" }),
      ...userSigner(ALICE),
    });
    expect(doc.operations.global.every((o) => o.error === undefined)).toBe(
      true,
    );
  });
});
