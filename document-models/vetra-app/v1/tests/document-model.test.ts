/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  assertIsVetraAppDocument,
  assertIsVetraAppState,
  initialGlobalState,
  initialLocalState,
  isVetraAppDocument,
  isVetraAppState,
  utils,
  vetraAppDocumentType,
} from "document-models/vetra-app/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("VetraApp Document Model", () => {
  it("should create a new VetraApp document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(vetraAppDocumentType);
  });

  it("should create a new VetraApp document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isVetraAppDocument(document)).toBe(true);
    expect(isVetraAppState(document.state)).toBe(true);
  });
  it("should reject a document that is not a VetraApp document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsVetraAppDocument(wrongDocumentType)).toThrow();
      expect(isVetraAppDocument(wrongDocumentType)).toBe(false);
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
    expect(isVetraAppState(wrongState.state)).toBe(false);
    expect(assertIsVetraAppState(wrongState.state)).toThrow();
    expect(isVetraAppDocument(wrongState)).toBe(false);
    expect(assertIsVetraAppDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isVetraAppState(wrongInitialState.state)).toBe(false);
    expect(assertIsVetraAppState(wrongInitialState.state)).toThrow();
    expect(isVetraAppDocument(wrongInitialState)).toBe(false);
    expect(assertIsVetraAppDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isVetraAppDocument(missingIdInHeader)).toBe(false);
    expect(assertIsVetraAppDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isVetraAppDocument(missingNameInHeader)).toBe(false);
    expect(assertIsVetraAppDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isVetraAppDocument(missingCreatedAtUtcIsoInHeader)).toBe(false);
    expect(assertIsVetraAppDocument(missingCreatedAtUtcIsoInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isVetraAppDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(false);
    expect(
      assertIsVetraAppDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
