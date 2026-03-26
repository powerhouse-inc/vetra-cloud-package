import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  enableService,
  disableService,
  initialize,
  isVetraCloudEnvironmentDocument,
  EnableServiceInputSchema,
  DisableServiceInputSchema,
  toggleService,
  updateServicePrefix,
  setServiceStatus,
  ToggleServiceInputSchema,
  UpdateServicePrefixInputSchema,
  SetServiceStatusInputSchema,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import { generateMock } from "@powerhousedao/codegen";

describe("ServicesOperations", () => {
  describe("ENABLE_SERVICE", () => {
    it("should add a service to the services array", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );

      expect(updatedDocument.state.global.services).toStrictEqual([
        { type: "CONNECT", prefix: "connect" },
      ]);
    });

    it("should add multiple different services", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      document = reducer(
        document,
        enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
      );
      document = reducer(
        document,
        enableService({ type: "FUSION", prefix: "fusion" }),
      );

      expect(document.state.global.services).toHaveLength(3);
      expect(document.state.global.services).toStrictEqual([
        { type: "CONNECT", prefix: "connect" },
        { type: "SWITCHBOARD", prefix: "switchboard" },
        { type: "FUSION", prefix: "fusion" },
      ]);
    });

    it("should prevent duplicate services of the same type", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "different-prefix" }),
      );

      expect(document.state.global.services).toHaveLength(1);
      expect(document.state.global.services[0]).toStrictEqual({
        type: "CONNECT",
        prefix: "connect",
      });
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          defaultPackageRegistry: null,
        }),
      );
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  describe("DISABLE_SERVICE", () => {
    it("should remove a service from the services array", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      document = reducer(
        document,
        enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
      );
      document = reducer(document, disableService({ type: "CONNECT" }));

      expect(document.state.global.services).toHaveLength(1);
      expect(document.state.global.services[0]).toStrictEqual({
        type: "SWITCHBOARD",
        prefix: "switchboard",
      });
    });

    it("should handle disabling a service that is not enabled", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        disableService({ type: "CONNECT" }),
      );

      expect(updatedDocument.state.global.services).toStrictEqual([]);
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      // Re-approve
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("should allow re-enabling a service after disabling", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      document = reducer(document, disableService({ type: "CONNECT" }));
      expect(document.state.global.services).toStrictEqual([]);

      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "new-prefix" }),
      );
      expect(document.state.global.services).toStrictEqual([
        { type: "CONNECT", prefix: "new-prefix" },
      ]);
    });
  });

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
});
