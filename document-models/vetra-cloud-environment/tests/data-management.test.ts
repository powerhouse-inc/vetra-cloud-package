import { generateMock } from "@powerhousedao/codegen";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  setEnvironmentName,
  SetEnvironmentNameInputSchema,
} from "vetra-cloud-package/document-models/vetra-cloud-environment";

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
});
