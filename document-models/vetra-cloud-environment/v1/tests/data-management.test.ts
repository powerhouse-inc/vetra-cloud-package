import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setLabel,
  setGenericSubdomain,
  setCustomDomain,
  initialize,
  isVetraCloudEnvironmentDocument,
  SetLabelInputSchema,
  SetGenericSubdomainInputSchema,
  SetCustomDomainInputSchema,
  setDnsRecords,
  SetDnsRecordsInputSchema,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import { generateMock } from "@powerhousedao/codegen";

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
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(document, setLabel({ label: "my-env" }));

      expect(document.state.global.genericSubdomain).toBe("sub-1");
      expect(document.state.global.customDomain).toStrictEqual({
        enabled: false,
        domain: null,
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
      });
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
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
    const input = generateMock(SetLabelInputSchema());

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
    const input = generateMock(SetGenericSubdomainInputSchema());

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
    const input = generateMock(SetCustomDomainInputSchema());

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
    const input = generateMock(SetDnsRecordsInputSchema());

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
});
