import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import {
  EnableServiceInputSchema,
  type EnableServiceInput,
  type DisableServiceInput,
} from "../../gen/schema/index.js";
import { reducer } from "../../gen/reducer.js";
import * as creators from "../../gen/services/creators.js";
import type { VetraCloudEnvironmentDocument } from "../../gen/types.js";

describe("Services Operations", () => {
  let document: VetraCloudEnvironmentDocument;

  beforeEach(() => {
    document = utils.createDocument();
  });

  it("should handle enableService operation", () => {
    const input: EnableServiceInput = generateMock(
      EnableServiceInputSchema(),
    );
    const updatedDocument = reducer(document, creators.enableService(input));

    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ENABLE_SERVICE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should have initial services as empty array", () => {
    expect(document.state.global.services).toEqual([]);
  });

  it("should add a service to the services array on ENABLE_SERVICE", () => {
    const input: EnableServiceInput = { serviceName: "CONNECT" };
    const updatedDocument = reducer(document, creators.enableService(input));

    expect(updatedDocument.state.global.services).toContain("CONNECT");
    expect(updatedDocument.state.global.services).toHaveLength(1);
  });

  it("should enable multiple different services", () => {
    const input1: EnableServiceInput = { serviceName: "CONNECT" };
    const input2: EnableServiceInput = { serviceName: "SWITCHBOARD" };

    let updatedDocument = reducer(document, creators.enableService(input1));
    updatedDocument = reducer(updatedDocument, creators.enableService(input2));

    expect(updatedDocument.state.global.services).toContain("CONNECT");
    expect(updatedDocument.state.global.services).toContain("SWITCHBOARD");
    expect(updatedDocument.state.global.services).toHaveLength(2);
  });

  it("should not duplicate a service that is already enabled", () => {
    const input: EnableServiceInput = { serviceName: "CONNECT" };

    let updatedDocument = reducer(document, creators.enableService(input));
    updatedDocument = reducer(updatedDocument, creators.enableService(input));

    expect(updatedDocument.state.global.services).toHaveLength(1);
    expect(updatedDocument.state.global.services).toContain("CONNECT");
  });

  it("should remove a service from the services array on DISABLE_SERVICE", () => {
    const enableInput: EnableServiceInput = { serviceName: "CONNECT" };
    const disableInput: DisableServiceInput = { serviceName: "CONNECT" };

    let updatedDocument = reducer(document, creators.enableService(enableInput));
    expect(updatedDocument.state.global.services).toContain("CONNECT");

    updatedDocument = reducer(
      updatedDocument,
      creators.disableService(disableInput),
    );
    expect(updatedDocument.state.global.services).not.toContain("CONNECT");
    expect(updatedDocument.state.global.services).toHaveLength(0);
  });

  it("should only remove the specified service when disabling", () => {
    const enableConnect: EnableServiceInput = { serviceName: "CONNECT" };
    const enableSwitchboard: EnableServiceInput = {
      serviceName: "SWITCHBOARD",
    };
    const disableConnect: DisableServiceInput = { serviceName: "CONNECT" };

    let updatedDocument = reducer(
      document,
      creators.enableService(enableConnect),
    );
    updatedDocument = reducer(
      updatedDocument,
      creators.enableService(enableSwitchboard),
    );
    expect(updatedDocument.state.global.services).toHaveLength(2);

    updatedDocument = reducer(
      updatedDocument,
      creators.disableService(disableConnect),
    );
    expect(updatedDocument.state.global.services).toHaveLength(1);
    expect(updatedDocument.state.global.services).toContain("SWITCHBOARD");
    expect(updatedDocument.state.global.services).not.toContain("CONNECT");
  });

  it("should handle enable, disable, then re-enable sequence", () => {
    const enableInput: EnableServiceInput = { serviceName: "CONNECT" };
    const disableInput: DisableServiceInput = { serviceName: "CONNECT" };

    let updatedDocument = reducer(document, creators.enableService(enableInput));
    expect(updatedDocument.state.global.services).toEqual(["CONNECT"]);

    updatedDocument = reducer(
      updatedDocument,
      creators.disableService(disableInput),
    );
    expect(updatedDocument.state.global.services).toEqual([]);

    updatedDocument = reducer(
      updatedDocument,
      creators.enableService(enableInput),
    );
    expect(updatedDocument.state.global.services).toEqual(["CONNECT"]);
    expect(updatedDocument.operations.global).toHaveLength(3);
  });

  it("should not affect other state fields when toggling services", () => {
    const input: EnableServiceInput = { serviceName: "CONNECT" };
    const updatedDocument = reducer(document, creators.enableService(input));

    expect(updatedDocument.state.global.name).toBeNull();
    expect(updatedDocument.state.global.status).toBe("STOPPED");
    expect(updatedDocument.state.global.packages).toBeNull();
  });
});
