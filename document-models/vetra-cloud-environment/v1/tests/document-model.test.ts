import { describe, it, expect } from "vitest";
import {
  utils,
  initialGlobalState,
  initialLocalState,
  vetraCloudEnvironmentDocumentType,
  isVetraCloudEnvironmentDocument,
  assertIsVetraCloudEnvironmentDocument,
  isVetraCloudEnvironmentState,
  assertIsVetraCloudEnvironmentState,
} from "document-models/vetra-cloud-environment/v1";
import { ZodError } from "zod";

describe("VetraCloudEnvironment Document Model", () => {
  it("should create a new VetraCloudEnvironment document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(
      vetraCloudEnvironmentDocumentType,
    );
  });

  it("should create a new VetraCloudEnvironment document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isVetraCloudEnvironmentDocument(document)).toBe(true);
    expect(isVetraCloudEnvironmentState(document.state)).toBe(true);
  });

  it("should have correct initial state shape", () => {
    const document = utils.createDocument();
    expect(document.state.global.label).toBeNull();
    expect(document.state.global.genericSubdomain).toBeNull();
    expect(document.state.global.customDomain).toStrictEqual({
      enabled: false,
      domain: null,
      dnsRecords: [],
    });
    expect(document.state.global.defaultPackageRegistry).toBeNull();
    expect(document.state.global.services).toStrictEqual([]);
    expect(document.state.global.packages).toStrictEqual([]);
    expect(document.state.global.status).toBe("DRAFT");
  });

  it("should reject a document that is not a VetraCloudEnvironment document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(
        assertIsVetraCloudEnvironmentDocument(wrongDocumentType),
      ).toThrow();
      expect(isVetraCloudEnvironmentDocument(wrongDocumentType)).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
    }
  });

  it("should reject a document with invalid state", () => {
    const wrongState = utils.createDocument();
    // @ts-expect-error - we are testing the error case
    wrongState.state.global = {
      ...{ notWhat: "you want" },
    };
    try {
      expect(isVetraCloudEnvironmentState(wrongState.state)).toBe(false);
      expect(assertIsVetraCloudEnvironmentState(wrongState.state)).toThrow();
      expect(isVetraCloudEnvironmentDocument(wrongState)).toBe(false);
      expect(assertIsVetraCloudEnvironmentDocument(wrongState)).toThrow();
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
    }
  });
});
