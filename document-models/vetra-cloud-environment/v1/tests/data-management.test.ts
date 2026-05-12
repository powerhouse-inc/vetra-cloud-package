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
  SetOwnerInputSchema,
  SetApexServiceInputSchema,
  SetAutoUpdateChannelInputSchema,
  setBackupSchedule,
  SetBackupScheduleInputSchema,
} from "document-models/vetra-cloud-environment/v1";
import { generateMock } from "@powerhousedao/codegen";

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

/** Build a signer context representing a system (app-only) signed action. */
const systemSigner = () => ({
  context: {
    signer: {
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
    const input = generateMock(SetOwnerInputSchema());

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
    const input = generateMock(SetApexServiceInputSchema());

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
    const input = generateMock(SetAutoUpdateChannelInputSchema());

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

  it("should handle setBackupSchedule operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetBackupScheduleInputSchema());

    const updatedDocument = reducer(document, setBackupSchedule(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_BACKUP_SCHEDULE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  describe("SET_BACKUP_SCHEDULE", () => {
    it("allows the owner to set the schedule", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setBackupSchedule({
          enabled: true,
          cadence: "DAILY",
          retention: 7,
        }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.backupSchedule).toStrictEqual({
        enabled: true,
        cadence: "DAILY",
        retention: 7,
      });
    });

    it("rejects a non-owner attempting to set the schedule", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setBackupSchedule({
          enabled: true,
          cadence: "DAILY",
          retention: 7,
        }),
        ...userSigner(BOB),
      });

      expect(document.state.global.backupSchedule).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /is not the owner/i,
      );
    });

    it("rejects retention outside the 1..30 range", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });

      // Above the upper bound.
      document = reducer(document, {
        ...setBackupSchedule({
          enabled: true,
          cadence: "DAILY",
          retention: 31,
        }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.backupSchedule).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /INVALID_RETENTION/,
      );

      // Below the lower bound.
      document = reducer(document, {
        ...setBackupSchedule({
          enabled: true,
          cadence: "DAILY",
          retention: 0,
        }),
        ...userSigner(ALICE),
      });
      expect(document.state.global.backupSchedule).toBeNull();
      expect(document.operations.global.at(-1)?.error).toMatch(
        /INVALID_RETENTION/,
      );
    });

    it("can be disabled while keeping the cadence/retention", () => {
      let document = utils.createDocument();
      document = reducer(document, {
        ...setOwner({ address: ALICE }),
        ...userSigner(ALICE),
      });
      document = reducer(document, {
        ...setBackupSchedule({
          enabled: false,
          cadence: "WEEKLY",
          retention: 4,
        }),
        ...userSigner(ALICE),
      });

      expect(document.state.global.backupSchedule).toStrictEqual({
        enabled: false,
        cadence: "WEEKLY",
        retention: 4,
      });
    });
  });
});
