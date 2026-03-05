/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

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
} from "vetra-cloud-package/document-models/vetra-cloud-environment";
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

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isVetraCloudEnvironmentState(wrongInitialState.state)).toBe(false);
    expect(
      assertIsVetraCloudEnvironmentState(wrongInitialState.state),
    ).toThrow();
    expect(isVetraCloudEnvironmentDocument(wrongInitialState)).toBe(false);
    expect(assertIsVetraCloudEnvironmentDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isVetraCloudEnvironmentDocument(missingIdInHeader)).toBe(false);
    expect(assertIsVetraCloudEnvironmentDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isVetraCloudEnvironmentDocument(missingNameInHeader)).toBe(false);
    expect(
      assertIsVetraCloudEnvironmentDocument(missingNameInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(
      isVetraCloudEnvironmentDocument(missingCreatedAtUtcIsoInHeader),
    ).toBe(false);
    expect(
      assertIsVetraCloudEnvironmentDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(
      isVetraCloudEnvironmentDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toBe(false);
    expect(
      assertIsVetraCloudEnvironmentDocument(
        missingLastModifiedAtUtcIsoInHeader,
      ),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
