import { generateMock } from "document-model";
import {
  disableService,
  DisableServiceInputSchema,
  enableService,
  EnableServiceInputSchema,
  isVetraCloudEnvironmentDocument,
  reducer,
  setServiceConfig,
  SetServiceConfigInputSchema,
  setServiceSize,
  SetServiceSizeInputSchema,
  setServiceStatus,
  SetServiceStatusInputSchema,
  setServiceVersion,
  SetServiceVersionInputSchema,
  toggleService,
  ToggleServiceInputSchema,
  updateServicePrefix,
  UpdateServicePrefixInputSchema,
  utils,
} from "document-models/vetra-cloud-environment/v1";
import { describe, expect, it } from "vitest";

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

  it("should handle setServiceConfig operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetServiceConfigInputSchema());

    const updatedDocument = reducer(document, setServiceConfig(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_SERVICE_CONFIG",
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

  it("should handle toggleService operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ToggleServiceInputSchema());

    const updatedDocument = reducer(document, toggleService(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "TOGGLE_SERVICE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle updateServicePrefix operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UpdateServicePrefixInputSchema());

    const updatedDocument = reducer(document, updateServicePrefix(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UPDATE_SERVICE_PREFIX",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setServiceStatus operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetServiceStatusInputSchema());

    const updatedDocument = reducer(document, setServiceStatus(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_SERVICE_STATUS",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setServiceVersion operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetServiceVersionInputSchema());

    const updatedDocument = reducer(document, setServiceVersion(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_SERVICE_VERSION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setServiceSize operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetServiceSizeInputSchema());

    const updatedDocument = reducer(document, setServiceSize(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_SERVICE_SIZE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
