import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import {
  SetEnvironmentNameInputSchema,
  type SetEnvironmentNameInput,
  type SetSubdomainInput,
  type SetCustomDomainInput,
} from "../../gen/schema/index.js";
import { reducer } from "../../gen/reducer.js";
import * as creators from "../../gen/data-management/creators.js";
import type { VetraCloudEnvironmentDocument } from "../../gen/types.js";

describe("DataManagement Operations", () => {
  let document: VetraCloudEnvironmentDocument;

  beforeEach(() => {
    document = utils.createDocument();
  });

  it("should handle setEnvironmentName operation", () => {
    const input: SetEnvironmentNameInput = generateMock(
      SetEnvironmentNameInputSchema(),
    );
    const updatedDocument = reducer(
      document,
      creators.setEnvironmentName(input),
    );

    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_ENVIRONMENT_NAME",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should have initial name of null", () => {
    expect(document.state.global.name).toBeNull();
  });

  it("should set the environment name in state", () => {
    const input: SetEnvironmentNameInput = { name: "production" };
    const updatedDocument = reducer(
      document,
      creators.setEnvironmentName(input),
    );
    expect(updatedDocument.state.global.name).toBe("production");
  });

  it("should update the environment name when set multiple times", () => {
    const input1: SetEnvironmentNameInput = { name: "staging" };
    const input2: SetEnvironmentNameInput = { name: "production" };

    let updatedDocument = reducer(
      document,
      creators.setEnvironmentName(input1),
    );
    expect(updatedDocument.state.global.name).toBe("staging");

    updatedDocument = reducer(
      updatedDocument,
      creators.setEnvironmentName(input2),
    );
    expect(updatedDocument.state.global.name).toBe("production");
    expect(updatedDocument.operations.global).toHaveLength(2);
  });

  it("should not affect other state fields when setting name", () => {
    const input: SetEnvironmentNameInput = { name: "my-environment" };
    const updatedDocument = reducer(
      document,
      creators.setEnvironmentName(input),
    );

    expect(updatedDocument.state.global.status).toBe("STOPPED");
    expect(updatedDocument.state.global.services).toEqual([]);
    expect(updatedDocument.state.global.packages).toBeNull();
  });

  // SET_SUBDOMAIN tests
  it("should have initial subdomain of null", () => {
    expect(document.state.global.subdomain).toBeNull();
  });

  it("should set the subdomain", () => {
    const input: SetSubdomainInput = { subdomain: "happy-bear-22" };
    const updatedDocument = reducer(
      document,
      creators.setSubdomain(input),
    );
    expect(updatedDocument.state.global.subdomain).toBe("happy-bear-22");
  });

  it("should not overwrite an existing subdomain", () => {
    const input1: SetSubdomainInput = { subdomain: "happy-bear-22" };
    const input2: SetSubdomainInput = { subdomain: "cool-wolf-99" };

    let updatedDocument = reducer(document, creators.setSubdomain(input1));
    expect(updatedDocument.state.global.subdomain).toBe("happy-bear-22");

    updatedDocument = reducer(updatedDocument, creators.setSubdomain(input2));
    expect(updatedDocument.state.global.subdomain).toBe("happy-bear-22");
  });

  // SET_CUSTOM_DOMAIN tests
  it("should have initial customDomain of null", () => {
    expect(document.state.global.customDomain).toBeNull();
  });

  it("should set a custom domain", () => {
    const input: SetCustomDomainInput = { customDomain: "app.acme.com" };
    const updatedDocument = reducer(
      document,
      creators.setCustomDomain(input),
    );
    expect(updatedDocument.state.global.customDomain).toBe("app.acme.com");
  });

  it("should clear custom domain with empty string", () => {
    const setInput: SetCustomDomainInput = { customDomain: "app.acme.com" };
    const clearInput: SetCustomDomainInput = { customDomain: "" };

    let updatedDocument = reducer(
      document,
      creators.setCustomDomain(setInput),
    );
    expect(updatedDocument.state.global.customDomain).toBe("app.acme.com");

    updatedDocument = reducer(
      updatedDocument,
      creators.setCustomDomain(clearInput),
    );
    expect(updatedDocument.state.global.customDomain).toBeNull();
  });

  it("should clear custom domain with null/undefined", () => {
    const setInput: SetCustomDomainInput = { customDomain: "app.acme.com" };
    const clearInput: SetCustomDomainInput = {};

    let updatedDocument = reducer(
      document,
      creators.setCustomDomain(setInput),
    );
    expect(updatedDocument.state.global.customDomain).toBe("app.acme.com");

    updatedDocument = reducer(
      updatedDocument,
      creators.setCustomDomain(clearInput),
    );
    expect(updatedDocument.state.global.customDomain).toBeNull();
  });
});
