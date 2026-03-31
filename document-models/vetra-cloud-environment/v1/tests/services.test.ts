import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  enableService,
  disableService,
  initialize,
  isVetraCloudEnvironmentDocument,
  toggleService,
  updateServicePrefix,
  setServiceStatus,
  setServiceVersion,
} from "document-models/vetra-cloud-environment/v1";

describe("ServicesOperations", () => {
  describe("ENABLE_SERVICE", () => {
    it("should add a service to the services array", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );

      expect(updatedDocument.state.global.services).toStrictEqual([
        {
          type: "CONNECT",
          prefix: "connect",
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
        },
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
        {
          type: "CONNECT",
          prefix: "connect",
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
        },
        {
          type: "SWITCHBOARD",
          prefix: "switchboard",
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
        },
        {
          type: "FUSION",
          prefix: "fusion",
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
        },
      ]);
    });

    it("should prevent duplicate services of the same type and update prefix", () => {
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
        prefix: "different-prefix",
        enabled: true,
        url: null,
        status: "PROVISIONING",
        version: null,
      });
    });

    it("should set status to CHANGES_PENDING", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          genericBaseDomain: "test.example.com",
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
    it("should disable a service in the services array", () => {
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

      expect(document.state.global.services).toHaveLength(2);
      expect(document.state.global.services[0]).toStrictEqual({
        type: "CONNECT",
        prefix: "connect",
        enabled: false,
        url: null,
        status: "PROVISIONING",
        version: null,
      });
      expect(document.state.global.services[1]).toStrictEqual({
        type: "SWITCHBOARD",
        prefix: "switchboard",
        enabled: true,
        url: null,
        status: "PROVISIONING",
        version: null,
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
          genericBaseDomain: "test.example.com",
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
      expect(document.state.global.services[0].enabled).toBe(false);

      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "new-prefix" }),
      );
      expect(document.state.global.services).toHaveLength(1);
      expect(document.state.global.services[0]).toStrictEqual({
        type: "CONNECT",
        prefix: "new-prefix",
        enabled: true,
        url: null,
        status: "PROVISIONING",
        version: null,
      });
    });
  });

  it("should handle enableService operation", () => {
    const document = utils.createDocument();
    const input = { type: "CONNECT" as const, prefix: "connect" };

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
    const input = { type: "CONNECT" as const };

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
    const input = { type: "SWITCHBOARD" as const };

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
    const input = { type: "CONNECT" as const, prefix: "new-prefix" };

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
    const input = { type: "CONNECT" as const, status: "ACTIVE" as const };

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

  describe("SET_SERVICE_VERSION", () => {
    it("should set version on an existing service", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      document = reducer(
        document,
        setServiceVersion({ type: "CONNECT", version: "1.2.3" }),
      );

      expect(document.state.global.services[0].version).toBe("1.2.3");
    });

    it("should error for unknown service", () => {
      const document = utils.createDocument();
      const result = reducer(
        document,
        setServiceVersion({ type: "FUSION", version: "1.0.0" }),
      );
      expect(result.operations.global[0].error).toBeDefined();
    });

    it("should set CHANGES_PENDING when deployed", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: null,
        }),
      );
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      // Simulate deployed state
      document = {
        ...document,
        state: {
          ...document.state,
          global: { ...document.state.global, status: "READY" as const },
        },
      };
      document = reducer(
        document,
        setServiceVersion({ type: "CONNECT", version: "2.0.0" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  it("should handle setServiceVersion operation", () => {
    let document = utils.createDocument();
    document = reducer(
      document,
      enableService({ type: "CONNECT", prefix: "connect" }),
    );
    const input = { type: "CONNECT" as const, version: "1.0.0" };

    const updatedDocument = reducer(document, setServiceVersion(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(2);
    expect(updatedDocument.operations.global[1].action.type).toBe(
      "SET_SERVICE_VERSION",
    );
    expect(updatedDocument.operations.global[1].action.input).toStrictEqual(
      input,
    );
  });
});
