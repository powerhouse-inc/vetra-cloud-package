import { generateMock } from "document-model";
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  isVetraCloudEnvironmentDocument,
  toggleAutoUpdate,
  setAutoUpdateChannel,
  setImageTag,
  ToggleAutoUpdateInputSchema,
  SetAutoUpdateChannelInputSchema,
  SetImageTagInputSchema,
} from "document-models/vetra-cloud-environment/v1";

describe("AutoUpdateOperations", () => {
  it("should handle toggleAutoUpdate operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ToggleAutoUpdateInputSchema());

    const updatedDocument = reducer(document, toggleAutoUpdate(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "TOGGLE_AUTO_UPDATE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setAutoUpdateChannel operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetAutoUpdateChannelInputSchema());

    const updatedDocument = reducer(document, setAutoUpdateChannel(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_AUTO_UPDATE_CHANNEL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setImageTag operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetImageTagInputSchema());

    const updatedDocument = reducer(document, setImageTag(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_IMAGE_TAG",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
