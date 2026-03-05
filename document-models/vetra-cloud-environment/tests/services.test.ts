import { generateMock } from "@powerhousedao/codegen";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  enableService,
  disableService,
  EnableServiceInputSchema,
  DisableServiceInputSchema,
} from "vetra-cloud-package/document-models/vetra-cloud-environment";

describe("ServicesOperations", () => {
  it("should handle enableService operation", () => {
    const document = utils.createDocument();
    const input = generateMock(EnableServiceInputSchema());

    const updatedDocument = reducer(document, enableService(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ENABLE_SERVICE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle disableService operation", () => {
    const document = utils.createDocument();
    const input = generateMock(DisableServiceInputSchema());

    const updatedDocument = reducer(document, disableService(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "DISABLE_SERVICE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
