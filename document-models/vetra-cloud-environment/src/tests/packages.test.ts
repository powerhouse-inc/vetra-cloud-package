import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import {
  AddPackageInputSchema,
  type AddPackageInput,
  type RemovePackageInput,
} from "../../gen/schema/index.js";
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

  it("should have initial packages as null", () => {
    expect(document.state.global.packages).toBeNull();
  });

  it("should add a package to the packages array", () => {
    const input: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };
    const updatedDocument = reducer(document, creators.addPackage(input));

    expect(updatedDocument.state.global.packages).toHaveLength(1);
    expect(updatedDocument.state.global.packages![0].name).toBe("my-package");
    expect(updatedDocument.state.global.packages![0].version).toBe("1.0.0");
  });

  it("should default version to 'latest' when not provided", () => {
    const input: AddPackageInput = { packageName: "my-package" };
    const updatedDocument = reducer(document, creators.addPackage(input));

    expect(updatedDocument.state.global.packages).toHaveLength(1);
    expect(updatedDocument.state.global.packages![0].version).toBe("latest");
  });

  it("should add multiple different packages", () => {
    const input1: AddPackageInput = {
      packageName: "package-a",
      version: "1.0.0",
    };
    const input2: AddPackageInput = {
      packageName: "package-b",
      version: "2.0.0",
    };

    let updatedDocument = reducer(document, creators.addPackage(input1));
    updatedDocument = reducer(updatedDocument, creators.addPackage(input2));

    expect(updatedDocument.state.global.packages).toHaveLength(2);
    expect(updatedDocument.state.global.packages![0].name).toBe("package-a");
    expect(updatedDocument.state.global.packages![1].name).toBe("package-b");
  });

  it("should not duplicate a package with same name and version", () => {
    const input: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };

    let updatedDocument = reducer(document, creators.addPackage(input));
    updatedDocument = reducer(updatedDocument, creators.addPackage(input));

    expect(updatedDocument.state.global.packages).toHaveLength(1);
  });

  it("should update version when adding same package with different version", () => {
    const input1: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };
    const input2: AddPackageInput = {
      packageName: "my-package",
      version: "2.0.0",
    };

    let updatedDocument = reducer(document, creators.addPackage(input1));
    expect(updatedDocument.state.global.packages![0].version).toBe("1.0.0");

    updatedDocument = reducer(updatedDocument, creators.addPackage(input2));
    expect(updatedDocument.state.global.packages).toHaveLength(1);
    expect(updatedDocument.state.global.packages![0].version).toBe("2.0.0");
  });

  it("should remove a package from the packages array", () => {
    const addInput: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };
    const removeInput: RemovePackageInput = { packageName: "my-package" };

    let updatedDocument = reducer(document, creators.addPackage(addInput));
    expect(updatedDocument.state.global.packages).toHaveLength(1);

    updatedDocument = reducer(
      updatedDocument,
      creators.removePackage(removeInput),
    );
    expect(updatedDocument.state.global.packages).toHaveLength(0);
  });

  it("should only remove the specified package when multiple exist", () => {
    const input1: AddPackageInput = {
      packageName: "package-a",
      version: "1.0.0",
    };
    const input2: AddPackageInput = {
      packageName: "package-b",
      version: "2.0.0",
    };
    const removeInput: RemovePackageInput = { packageName: "package-a" };

    let updatedDocument = reducer(document, creators.addPackage(input1));
    updatedDocument = reducer(updatedDocument, creators.addPackage(input2));
    expect(updatedDocument.state.global.packages).toHaveLength(2);

    updatedDocument = reducer(
      updatedDocument,
      creators.removePackage(removeInput),
    );
    expect(updatedDocument.state.global.packages).toHaveLength(1);
    expect(updatedDocument.state.global.packages![0].name).toBe("package-b");
  });

  it("should handle add, remove, then re-add sequence", () => {
    const addInput: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };
    const removeInput: RemovePackageInput = { packageName: "my-package" };
    const reAddInput: AddPackageInput = {
      packageName: "my-package",
      version: "2.0.0",
    };

    let updatedDocument = reducer(document, creators.addPackage(addInput));
    expect(updatedDocument.state.global.packages![0].version).toBe("1.0.0");

    updatedDocument = reducer(
      updatedDocument,
      creators.removePackage(removeInput),
    );
    expect(updatedDocument.state.global.packages).toHaveLength(0);

    updatedDocument = reducer(updatedDocument, creators.addPackage(reAddInput));
    expect(updatedDocument.state.global.packages).toHaveLength(1);
    expect(updatedDocument.state.global.packages![0].version).toBe("2.0.0");
    expect(updatedDocument.operations.global).toHaveLength(3);
  });

  it("should not affect other state fields when managing packages", () => {
    const input: AddPackageInput = {
      packageName: "my-package",
      version: "1.0.0",
    };
    const updatedDocument = reducer(document, creators.addPackage(input));

    expect(updatedDocument.state.global.name).toBeNull();
    expect(updatedDocument.state.global.status).toBe("STOPPED");
    expect(updatedDocument.state.global.services).toEqual([]);
  });
});
