import { generateMock } from "@powerhousedao/common/utils";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  addPackage,
  removePackage,
  AddPackageInputSchema,
  RemovePackageInputSchema,
} from "vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  addPackage,
  removePackage,
  AddPackageInputSchema,
  RemovePackageInputSchema,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

describe("PackagesOperations", () => {
  it("should handle addPackage operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddPackageInputSchema());

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
});
