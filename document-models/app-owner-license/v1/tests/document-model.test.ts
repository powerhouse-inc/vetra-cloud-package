/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  appOwnerLicenseDocumentType,
  assertIsAppOwnerLicenseDocument,
  assertIsAppOwnerLicenseState,
  initialGlobalState,
  initialLocalState,
  isAppOwnerLicenseDocument,
  isAppOwnerLicenseState,
  utils,
} from "document-models/app-owner-license/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("AppOwnerLicense Document Model", () => {
  it("should create a new AppOwnerLicense document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(appOwnerLicenseDocumentType);
  });

  it("should create a new AppOwnerLicense document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isAppOwnerLicenseDocument(document)).toBe(true);
    expect(isAppOwnerLicenseState(document.state)).toBe(true);
  });
  it("should reject a document that is not a AppOwnerLicense document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsAppOwnerLicenseDocument(wrongDocumentType)).toThrow();
      expect(isAppOwnerLicenseDocument(wrongDocumentType)).toBe(false);
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
    expect(isAppOwnerLicenseState(wrongState.state)).toBe(false);
    expect(assertIsAppOwnerLicenseState(wrongState.state)).toThrow();
    expect(isAppOwnerLicenseDocument(wrongState)).toBe(false);
    expect(assertIsAppOwnerLicenseDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isAppOwnerLicenseState(wrongInitialState.state)).toBe(false);
    expect(assertIsAppOwnerLicenseState(wrongInitialState.state)).toThrow();
    expect(isAppOwnerLicenseDocument(wrongInitialState)).toBe(false);
    expect(assertIsAppOwnerLicenseDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isAppOwnerLicenseDocument(missingIdInHeader)).toBe(false);
    expect(assertIsAppOwnerLicenseDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isAppOwnerLicenseDocument(missingNameInHeader)).toBe(false);
    expect(assertIsAppOwnerLicenseDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isAppOwnerLicenseDocument(missingCreatedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAppOwnerLicenseDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isAppOwnerLicenseDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAppOwnerLicenseDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
