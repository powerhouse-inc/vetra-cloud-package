/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import { AddPackageInputSchema, type AddPackageInput } from "../../gen/schema/index.js";
import { reducer } from "../../gen/reducer.js";
import * as creators from "../../gen/packages/creators.js";
import type { VetraCloudEnvironmentDocument } from "../../gen/types.js";

describe("Packages Operations", () => {
  let document: VetraCloudEnvironmentDocument;

  beforeEach(() => {
    document = utils.createDocument();
  });

  it("should handle addPackage operation", () => {
    const input: AddPackageInput = generateMock(AddPackageInputSchema());

    const updatedDocument = reducer(document, creators.addPackage(input));

    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ADD_PACKAGE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
