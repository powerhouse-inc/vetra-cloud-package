import { generateMock } from "document-model";
import {
  isVetraCloudEnvironmentDocument,
  reducer,
  setApexService,
  SetApexServiceInputSchema,
  setAutoUpdateChannel,
  SetAutoUpdateChannelInputSchema,
  setCustomDomain,
  SetCustomDomainInputSchema,
  setDefaultPackageRegistry,
  SetDefaultPackageRegistryInputSchema,
  setDnsRecords,
  SetDnsRecordsInputSchema,
  setGenericSubdomain,
  SetGenericSubdomainInputSchema,
  setLabel,
  SetLabelInputSchema,
  setOwner,
  SetOwnerInputSchema,
  setRuntimeConfig,
  SetRuntimeConfigInputSchema,
  utils,
} from "document-models/vetra-cloud-environment/v1";
import { describe, expect, it } from "vitest";

describe("DataManagementOperations", () => {
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

  it("should handle setDefaultPackageRegistry operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetDefaultPackageRegistryInputSchema(), {
      defaultPackageRegistry: "https://example.com",
    });

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

  it("should handle setRuntimeConfig operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetRuntimeConfigInputSchema());

    const updatedDocument = reducer(document, setRuntimeConfig(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_RUNTIME_CONFIG",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
