import { generateMock } from "@powerhousedao/codegen";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  start,
  stop,
  StartInputSchema,
  StopInputSchema,
} from "vetra-cloud-package/document-models/vetra-cloud-environment";

describe("StatusOperations", () => {
  it("should handle start operation", () => {
    const document = utils.createDocument();
    const input = generateMock(StartInputSchema());

    const updatedDocument = reducer(document, start(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("START");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle stop operation", () => {
    const document = utils.createDocument();
    const input = generateMock(StopInputSchema());

    const updatedDocument = reducer(document, stop(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("STOP");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
