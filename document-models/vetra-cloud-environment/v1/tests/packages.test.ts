import { generateMock } from "document-model";
import {
  addPackage,
  AddPackageInputSchema,
  isVetraCloudEnvironmentDocument,
  reducer,
  removePackage,
  RemovePackageInputSchema,
  setPackageVersion,
  SetPackageVersionInputSchema,
  utils,
} from "document-models/vetra-cloud-environment/v1";
import { describe, expect, it } from "vitest";

describe("PackagesOperations", () => {
  it("should handle addPackage operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddPackageInputSchema(), {
      registry: "https://example.com",
    });

    const updatedDocument = reducer(document, addPackage(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ADD_PACKAGE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle removePackage operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RemovePackageInputSchema());

    const updatedDocument = reducer(document, removePackage(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REMOVE_PACKAGE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setPackageVersion operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetPackageVersionInputSchema());

    const updatedDocument = reducer(document, setPackageVersion(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_PACKAGE_VERSION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
