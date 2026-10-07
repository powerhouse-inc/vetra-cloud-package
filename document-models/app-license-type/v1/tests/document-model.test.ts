/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  appLicenseTypeDocumentType,
  assertIsAppLicenseTypeDocument,
  assertIsAppLicenseTypeState,
  initialGlobalState,
  initialLocalState,
  isAppLicenseTypeDocument,
  isAppLicenseTypeState,
  utils,
} from "document-models/app-license-type/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("AppLicenseType Document Model", () => {
  it("should create a new AppLicenseType document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(appLicenseTypeDocumentType);
  });

  it("should create a new AppLicenseType document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isAppLicenseTypeDocument(document)).toBe(true);
    expect(isAppLicenseTypeState(document.state)).toBe(true);
  });
  it("should reject a document that is not a AppLicenseType document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsAppLicenseTypeDocument(wrongDocumentType)).toThrow();
      expect(isAppLicenseTypeDocument(wrongDocumentType)).toBe(false);
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
    expect(isAppLicenseTypeState(wrongState.state)).toBe(false);
    expect(assertIsAppLicenseTypeState(wrongState.state)).toThrow();
    expect(isAppLicenseTypeDocument(wrongState)).toBe(false);
    expect(assertIsAppLicenseTypeDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isAppLicenseTypeState(wrongInitialState.state)).toBe(false);
    expect(assertIsAppLicenseTypeState(wrongInitialState.state)).toThrow();
    expect(isAppLicenseTypeDocument(wrongInitialState)).toBe(false);
    expect(assertIsAppLicenseTypeDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isAppLicenseTypeDocument(missingIdInHeader)).toBe(false);
    expect(assertIsAppLicenseTypeDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isAppLicenseTypeDocument(missingNameInHeader)).toBe(false);
    expect(assertIsAppLicenseTypeDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isAppLicenseTypeDocument(missingCreatedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAppLicenseTypeDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isAppLicenseTypeDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAppLicenseTypeDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
