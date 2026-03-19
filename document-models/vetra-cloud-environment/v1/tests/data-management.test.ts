import { generateMock } from "@powerhousedao/common/utils";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  setEnvironmentName,
  SetEnvironmentNameInputSchema,
} from "vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  setEnvironmentName,
  setSubdomain,
  setCustomDomain,
  SetEnvironmentNameInputSchema,
  SetSubdomainInputSchema,
  SetCustomDomainInputSchema,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

describe("DataManagementOperations", () => {
  it("should handle setEnvironmentName operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetEnvironmentNameInputSchema());

    const updatedDocument = reducer(document, setEnvironmentName(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_ENVIRONMENT_NAME",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setSubdomain operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetSubdomainInputSchema());

    const updatedDocument = reducer(document, setSubdomain(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_SUBDOMAIN",
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
});
