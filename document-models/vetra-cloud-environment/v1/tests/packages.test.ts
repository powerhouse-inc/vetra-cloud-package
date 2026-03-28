import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  addPackage,
  removePackage,
  initialize,
  isVetraCloudEnvironmentDocument,
  AddPackageInputSchema,
  RemovePackageInputSchema,
} from "document-models/vetra-cloud-environment/v1";
import { generateMock } from "@powerhousedao/codegen";

describe("PackagesOperations", () => {
  describe("ADD_PACKAGE", () => {
    it("should add a package with default version 'latest'", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        addPackage({ packageName: "my-package" }),
      );

      expect(updatedDocument.state.global.packages).toStrictEqual([
        { registry: "", name: "my-package", version: "latest" },
      ]);
    });

    it("should add a package with explicit version", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        addPackage({ packageName: "my-package", version: "1.0.0" }),
      );

      expect(updatedDocument.state.global.packages).toStrictEqual([
        { registry: "", name: "my-package", version: "1.0.0" },
      ]);
    });

    it("should use explicit registry when provided", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        addPackage({
          packageName: "my-package",
          registry: "https://custom-registry.com",
        }),
      );

      expect(updatedDocument.state.global.packages[0].registry).toBe(
        "https://custom-registry.com",
      );
    });

    it("should use defaultPackageRegistry when no registry is provided", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        initialize({
          genericSubdomain: "test",
          genericBaseDomain: "test.example.com",
          defaultPackageRegistry: "https://default-registry.com",
        }),
      );

      document = reducer(document, addPackage({ packageName: "my-package" }));

      expect(document.state.global.packages[0].registry).toBe(
        "https://default-registry.com",
      );
    });

    it("should update version of existing package", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        addPackage({ packageName: "my-package", version: "1.0.0" }),
      );
      document = reducer(
        document,
        addPackage({ packageName: "my-package", version: "2.0.0" }),
      );

      expect(document.state.global.packages).toHaveLength(1);
      expect(document.state.global.packages[0].version).toBe("2.0.0");
    });

    it("should update registry of existing package when provided", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        addPackage({
          packageName: "my-package",
          registry: "https://old-registry.com",
        }),
      );
      document = reducer(
        document,
        addPackage({
          packageName: "my-package",
          registry: "https://new-registry.com",
        }),
      );

      expect(document.state.global.packages).toHaveLength(1);
      expect(document.state.global.packages[0].registry).toBe(
        "https://new-registry.com",
      );
    });

    it("should add multiple different packages", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        addPackage({ packageName: "package-a", version: "1.0.0" }),
      );
      document = reducer(
        document,
        addPackage({ packageName: "package-b", version: "2.0.0" }),
      );

      expect(document.state.global.packages).toHaveLength(2);
      expect(document.state.global.packages[0].name).toBe("package-a");
      expect(document.state.global.packages[1].name).toBe("package-b");
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

      document = reducer(document, addPackage({ packageName: "my-package" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  describe("REMOVE_PACKAGE", () => {
    it("should remove a package by name", () => {
      let document = utils.createDocument();
      document = reducer(document, addPackage({ packageName: "package-a" }));
      document = reducer(document, addPackage({ packageName: "package-b" }));
      document = reducer(document, removePackage({ packageName: "package-a" }));

      expect(document.state.global.packages).toHaveLength(1);
      expect(document.state.global.packages[0].name).toBe("package-b");
    });

    it("should handle removing a package that does not exist", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        removePackage({ packageName: "nonexistent" }),
      );

      expect(updatedDocument.state.global.packages).toStrictEqual([]);
    });

    it("should allow re-adding a removed package", () => {
      let document = utils.createDocument();
      document = reducer(
        document,
        addPackage({ packageName: "my-package", version: "1.0.0" }),
      );
      document = reducer(
        document,
        removePackage({ packageName: "my-package" }),
      );
      document = reducer(
        document,
        addPackage({ packageName: "my-package", version: "2.0.0" }),
      );

      expect(document.state.global.packages).toHaveLength(1);
      expect(document.state.global.packages[0].version).toBe("2.0.0");
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
      document = reducer(document, addPackage({ packageName: "my-package" }));
      // Already CHANGES_PENDING from addPackage, but let's verify removePackage also does it
      document = reducer(
        document,
        removePackage({ packageName: "my-package" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  it("should handle addPackage operation", () => {
    const document = utils.createDocument();
    const input = {
      ...generateMock(AddPackageInputSchema()),
      registry: "https://registry.example.com",
    };

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
