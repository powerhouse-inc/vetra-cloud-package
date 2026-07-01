import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setLabel,
  setGenericSubdomain,
  setCustomDomain,
  initialize,
  isVetraCloudEnvironmentDocument,
  setDnsRecords,
  setDefaultPackageRegistry,
  setOwner,
  setApexService,
  enableService,
  setAutoUpdateChannel,
  setRuntimeConfig,
} from "document-models/vetra-cloud-environment/v1";

const ALICE = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ALICE_LOWER = ALICE.toLowerCase();
const BOB = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BOB_LOWER = BOB.toLowerCase();

/** Build a signer context representing a user-signed action. */
const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

/**
 * Build a signer context representing a system (app-only) signed action.
 * `ActionSigner` requires a `user`, so we supply one with an empty address:
 * the reducers treat a falsy `signer.user.address` as "no user" (system-signed).
 */
const systemSigner = () => ({
  context: {
    signer: {
      user: { address: "", networkId: "", chainId: 0 },
      app: { name: "switchboard", key: "system" },
      signatures: [],
    },
  },
});

describe("DataManagementOperations", () => {
  describe("SET_LABEL", () => {
    it("should set the label on the environment", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        setLabel({ label: "my-environment" }),
      );

      expect(updatedDocument.state.global.label).toBe("my-environment");
    });

    it("should update the label when called again", () => {
      let document = utils.createDocument();
      document = reducer(document, setLabel({ label: "first" }));
      document = reducer(document, setLabel({ label: "second" }));

      expect(document.state.global.label).toBe("second");
    });

    it("should set status to CHANGES_PENDING when label is set", () => {
      let document = utils.createDocument();
      // Initialize first to get out of DRAFT
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test-sub",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: null,
        }),
      );
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      document = reducer(document, setLabel({ label: "new-label" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("should not affect other state fields", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "sub-1",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(document, setLabel({ label: "my-env" }));

      expect(document.state.global.genericSubdomain).toBe("sub-1");
      expect(document.state.global.customDomain).toStrictEqual({
        enabled: false,
        domain: null,
        dnsRecords: [],
      });
      expect(document.state.global.services).toStrictEqual([]);
      expect(document.state.global.packages).toStrictEqual([]);
    });
  });

  describe("SET_GENERIC_SUBDOMAIN", () => {
    it("should set the genericSubdomain", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        setGenericSubdomain({ genericSubdomain: "my-subdomain" }),
      );

      expect(updatedDocument.state.global.genericSubdomain).toBe(
        "my-subdomain",
      );
    });

    it("should allow updating the genericSubdomain", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        setGenericSubdomain({ genericSubdomain: "first" }),
      );
      document = reducer(
        document,
        setGenericSubdomain({ genericSubdomain: "second" }),
      );

      expect(document.state.global.genericSubdomain).toBe("second");
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(
        document,
        setGenericSubdomain({ genericSubdomain: "updated" }),
      );

      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  describe("SET_CUSTOM_DOMAIN", () => {
    it("should set custom domain with enabled true and a domain", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        setCustomDomain({ enabled: true, domain: "example.com" }),
      );

      expect(updatedDocument.state.global.customDomain).toStrictEqual({
        enabled: true,
        domain: "example.com",
        dnsRecords: [],
      });
    });

    it("should set custom domain with enabled false", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        setCustomDomain({ enabled: false }),
      );

      expect(updatedDocument.state.global.customDomain).toStrictEqual({
        enabled: false,
        domain: null,
        dnsRecords: [],
      });
    });

    it("should clear the domain when not provided", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        setCustomDomain({ enabled: true, domain: "example.com" }),
      );
      document = reducer(document, setCustomDomain({ enabled: true }));

      expect(document.state.global.customDomain).toStrictEqual({
        enabled: true,
        domain: null,
        dnsRecords: [],
      });
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(
        document,
        setCustomDomain({ enabled: true, domain: "test.com" }),
      );

      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  it("should handle setLabel operation", () => {
    const document = utils.createDocument();
    const input = { label: "test-label" };

    const updatedDocument = reducer(document, setLabel(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("SET_LABEL");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setGenericSubdomain operation", () => {
    const document = utils.createDocument();
    const input = { genericSubdomain: "test-subdomain" };

    const updatedDocument = reducer(document, setGenericSubdomain(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_GENERIC_SUBDOMAIN",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setCustomDomain operation", () => {
    const document = utils.createDocument();
    const input = { enabled: true, domain: "custom.example.com" };

    const updatedDocument = reducer(document, setCustomDomain(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_CUSTOM_DOMAIN",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setDnsRecords operation", () => {
    const document = utils.createDocument();
    const input = {
      records: [{ type: "A", host: "example.com", value: "1.2.3.4" }],
    };

    const updatedDocument = reducer(document, setDnsRecords(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_DNS_RECORDS",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setDefaultPackageRegistry operation", () => {
    const document = utils.createDocument();
    const input = { defaultPackageRegistry: "https://registry.example.com" };

    const updatedDocument = reducer(document, setDefaultPackageRegistry(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_DEFAULT_PACKAGE_REGISTRY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  describe("SET_OWNER", () => {
    it("claims ownership when unowned (user-signed, self-address)", () => {
      const document = utils.createDocument();
      const claim = {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      };

      const updated = reducer(document, claim);

      expect(updated.state.global.owner).toBe(ALICE_LOWER);
      expect(isVetraCloudEnvironmentDocument(updated)).toBe(true);
      expect(updated.operations.global).toHaveLength(1);
      expect(updated.operations.global[0].action.type).toBe("SET_OWNER");
    });

    it("rejects user-signed claim to a different address than signer", () => {
      const document = utils.createDocument();
      const claim = {
        ...setOwner({ address: BOB }),
        ...userSigner(ALICE),
      };

      const updated = reducer(document, claim);

      // The reducer throws SelfClaimRequiredError; the document-model
      // captures the error on the op and leaves state unchanged.
      expect(updated.state.global.owner).toBeNull();
      expect(updated.operations.global[0].error).toMatch(
        /signer's own address/i,
      );
    });

    it("allows system-signed claim to an arbitrary address when unowned (backfill)", () => {
      const document = utils.createDocument();
      const claim = {
        ...setOwner({ address: ALICE }),
        ...systemSigner(),
      };

      const updated = reducer(document, claim);

      expect(updated.state.global.owner).toBe(ALICE_LOWER);
    });

    it("transfers ownership when signed by the current owner", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });

      document = reducer(document, {
        ...setOwner({ address: BOB }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.owner).toBe(BOB_LOWER);
    });

    it("rejects transfer attempt from a non-owner signer", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });

      document = reducer(document, {
        ...setOwner({ address: BOB }),
        ...userSigner(BOB),
      });

      expect(document.state.global.owner).toBe(ALICE_LOWER);
      expect(document.operations.global.at(-1)?.error).toMatch(
        /current owner can transfer/i,
      );
    });

    it("gates subsequent mutations by the owner", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });

      // Non-owner label update — rejected.
      document = reducer(document, {
        ...setLabel({ label: "by-bob" }),
        ...userSigner(BOB),
      });
      expect(document.state.global.label).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /is not the owner/i,
      );

      // Owner label update — allowed.
      document = reducer(document, {
        ...setLabel({ label: "by-alice" }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.label).toBe("by-alice");
    });

    it("auto-claims ownership on the first user-signed mutation of an unowned env", () => {
      let document = utils.createDocument();
      // No SET_OWNER yet; assertOwner should set owner to the signer.
      document = reducer(document, {
        ...setLabel({ label: "auto-claimed" }),
        ...userSigner(BOB),
      });
      expect(document.state.global.label).toBe("auto-claimed");
      expect(document.state.global.owner).toBe(BOB_LOWER);

      // Subsequent mutation from a non-owner is now rejected.
      document = reducer(document, {
        ...setLabel({ label: "by-alice" }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.label).toBe("auto-claimed");
      expect(document.operations.global.at(-1)?.error).toMatch(
        /is not the owner/i,
      );
    });

    it("does not auto-claim on system-signed actions against unowned envs", () => {
      let document = utils.createDocument();
      // System-signed (no user) — common for the deployment reconciler.
      document = reducer(document, {
        ...setLabel({ label: "system-touch" }),
        ...systemSigner(),
      });
      expect(document.state.global.label).toBe("system-touch");
      expect(document.state.global.owner).toBeNull();
    });
  });

  describe("setApexService", () => {
    /** Build a doc that has Alice as owner and CONNECT enabled. */
    const initedWithConnect = () => {
      let doc = utils.createDocument();
      doc = reducer(doc, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      doc = reducer(doc, {
        ...enableService({ type: "CONNECT", prefix: "connect" }),
        ...userSigner(ALICE),
      });
      return doc;
    };

    it("sets apexService when the targeted service is enabled", () => {
      let doc = initedWithConnect();
      doc = reducer(doc, {
        ...setApexService({ type: "CONNECT" }),
        ...userSigner(ALICE),
      });
      expect(doc.state.global.apexService).toBe("CONNECT");
    });

    it("clears apexService when type is null", () => {
      let doc = initedWithConnect();
      doc = reducer(doc, {
        ...setApexService({ type: "CONNECT" }),
        ...userSigner(ALICE),
      });
      doc = reducer(doc, {
        ...setApexService({ type: null }),
        ...userSigner(ALICE),
      });
      expect(doc.state.global.apexService).toBeNull();
    });

    it("rejects pinning a service that is not enabled", () => {
      let doc = utils.createDocument();
      doc = reducer(doc, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      doc = reducer(doc, {
        ...setApexService({ type: "SWITCHBOARD" }),
        ...userSigner(ALICE),
      });
      const op = doc.operations.global[doc.operations.global.length - 1];
      expect(op.error).toBeDefined();
      expect(doc.state.global.apexService).toBeNull();
    });
  });

  it("should handle setOwner operation", () => {
    const document = utils.createDocument();
    const input = { address: ALICE };

    const updatedDocument = reducer(document, setOwner(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("SET_OWNER");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setApexService operation", () => {
    const document = utils.createDocument();
    const input = { type: null };

    const updatedDocument = reducer(document, setApexService(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_APEX_SERVICE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setAutoUpdateChannel operation", () => {
    const document = utils.createDocument();
    const input = { channel: null };

    const updatedDocument = reducer(document, setAutoUpdateChannel(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_AUTO_UPDATE_CHANNEL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  describe("SET_RUNTIME_CONFIG", () => {
    // runtimeConfig is stored as a JSON String (federation-composable scalar);
    // the input `config` is the JSON-stringified { connect, packageRegistryUrl }.
    it("stores a valid runtime config (connect + packageRegistryUrl, owner-signed)", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      const config = {
        connect: { app: { logLevel: "debug" } },
        packageRegistryUrl: "https://registry.example/-/cdn/",
      };
      document = reducer(document, {
        ...setRuntimeConfig({ config: JSON.stringify(config) }),
        ...userSigner(ALICE),
      });

      expect(JSON.parse(document.state.global.runtimeConfig as string)).toEqual(
        config,
      );
      expect(document.operations.global.at(-1)?.error).toBeUndefined();
    });

    it("rejects an invalid connect value (bad enum) without mutating state", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({
          config: JSON.stringify({ connect: { app: { logLevel: "verbose" } } }),
        }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /invalid runtime config/i,
      );
    });

    it("rejects a non-JSON string", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({ config: "not valid json" }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(/valid json/i);
    });

    it("rejects a non-string packageRegistryUrl", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({ config: JSON.stringify({ packageRegistryUrl: 123 }) }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /invalid runtime config/i,
      );
    });

    it("rejects unknown top-level keys (additionalProperties: false)", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      // `app` is a connect.* key, not a top-level key — must be nested under connect.
      document = reducer(document, {
        ...setRuntimeConfig({ config: JSON.stringify({ app: { logLevel: "debug" } }) }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /invalid runtime config/i,
      );
    });

    it("clears overrides when given null", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({
          config: JSON.stringify({ connect: { app: { logLevel: "info" } } }),
        }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.runtimeConfig).not.toBeNull();

      document = reducer(document, {
        ...setRuntimeConfig({ config: null }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.runtimeConfig).toBeNull();
    });

    it("treats an empty-object string as a clear", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({ config: "{}" }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toBeUndefined();
    });

    it("rejects a non-owner signer", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setRuntimeConfig({
          config: JSON.stringify({ connect: { app: { logLevel: "debug" } } }),
        }),
        ...userSigner(BOB),
      });

      expect(document.state.global.runtimeConfig).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /is not the owner/i,
      );
    });

    it("moves a deployed env to CHANGES_PENDING (gated, flows through approve → deploy)", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "sub",
          genericBaseDomain: "vetra.io",
          defaultPackageRegistry: null,
        }),
      );
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      const config = { connect: { app: { logLevel: "warn" } } };
      document = reducer(document, {
        ...setRuntimeConfig({ config: JSON.stringify(config) }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.status).toBe("CHANGES_PENDING");
      expect(JSON.parse(document.state.global.runtimeConfig as string)).toEqual(
        config,
      );
    });
  });
});
