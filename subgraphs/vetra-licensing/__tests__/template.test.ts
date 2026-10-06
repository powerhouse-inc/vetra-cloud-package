import { describe, it, expect } from "vitest";
import {
  renderTemplateActions,
  templateHash,
  UnknownTemplateSizeError,
  type TemplateShape,
} from "../template.js";

const template: TemplateShape = {
  services: [
    { id: "s1", type: "CONNECT", prefix: "connect" },
    { id: "s2", type: "SWITCHBOARD", prefix: "switchboard" },
  ],
  packages: [{ id: "p1", packageName: "@powerhousedao/knowledge", version: "1.0.0" }],
  size: "VETRA_AGENT_XXL",
  baseDomain: "vetra.io",
  packageRegistry: "https://registry.example.com",
};

describe("renderTemplateActions", () => {
  it("emits initialize, owner, packages, services and approval in order", () => {
    const actions = renderTemplateActions({
      label: "Acme vault",
      subdomain: "acme-vault",
      owner: "0x1111111111111111111111111111111111111111",
      template,
    });
    expect(actions.map((a) => a.type)).toEqual([
      "SET_LABEL",
      "INITIALIZE",
      "SET_OWNER",
      "ADD_PACKAGE",
      "ENABLE_SERVICE",
      "ENABLE_SERVICE",
      "APPROVE_CHANGES",
    ]);
  });

  it("renders a browser-only template with no switchboard", () => {
    const actions = renderTemplateActions({
      label: "Browser vault",
      subdomain: "browser-vault",
      owner: "0x1111111111111111111111111111111111111111",
      template: { ...template, services: [{ id: "s1", type: "CONNECT", prefix: "connect" }], size: null },
    });
    expect(actions.filter((a) => a.type === "ENABLE_SERVICE")).toHaveLength(1);
  });

  it("refuses an unrecognised size rather than silently shrinking the environment", () => {
    expect(() =>
      renderTemplateActions({
        label: "Acme vault",
        subdomain: "acme-vault",
        owner: "0x1111111111111111111111111111111111111111",
        template: { ...template, size: "XXL" },
      }),
    ).toThrow(UnknownTemplateSizeError);
  });
});

describe("templateHash", () => {
  it("is stable across key order", () => {
    const reordered: TemplateShape = {
      packages: template.packages,
      baseDomain: template.baseDomain,
      services: template.services,
      packageRegistry: template.packageRegistry,
      size: template.size,
    };
    expect(templateHash(reordered)).toBe(templateHash(template));
  });

  it("changes when the size changes", () => {
    expect(templateHash({ ...template, size: "VETRA_AGENT_S" })).not.toBe(
      templateHash(template),
    );
  });

  it("changes when a service is added", () => {
    const more: TemplateShape = {
      ...template,
      services: [...template.services, { id: "s3", type: "CLINT", prefix: "agent" }],
    };
    expect(templateHash(more)).not.toBe(templateHash(template));
  });
});
