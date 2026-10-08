import { describe, it, expect } from "vitest";
import {
  defaultGlobalState,
  type VetraCloudEnvironmentService,
  type VetraCloudEnvironmentState,
} from "document-models/vetra-cloud-environment";
import type { Action } from "document-model";
import {
  renderCreateActions,
  renderUpdateActions,
  renderFloorUpdateActions,
  isVersionUpgrade,
  templateHash,
  validateTemplate,
  MissingPackageNameError,
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  type TemplateShape,
} from "../template.js";

const template: TemplateShape = {
  services: [
    { id: "s1", type: "CONNECT", prefix: "connect" },
    { id: "s2", type: "SWITCHBOARD", prefix: "switchboard" },
  ],
  packages: [
    { id: "p1", packageName: "@powerhousedao/knowledge", version: "1.0.0" },
  ],
  size: "VETRA_AGENT_XXL",
  baseDomain: "vetra.io",
  packageRegistry: "https://registry.example.com",
};

const OWNER = "0x1111111111111111111111111111111111111111";

const types = (actions: Action[]) => actions.map((a) => a.type);

const enabled = (
  type: VetraCloudEnvironmentService["type"],
  prefix: string,
): VetraCloudEnvironmentService => ({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "ACTIVE",
  version: null,
  config: null,
  selectedRessource: null,
});

/** The state of an environment that was built from `template` and deployed. */
const deployedState = (): VetraCloudEnvironmentState => ({
  ...defaultGlobalState(),
  status: "READY",
  owner: OWNER,
  label: "Acme vault",
  services: [
    enabled("CONNECT", "connect"),
    enabled("SWITCHBOARD", "switchboard"),
  ],
  packages: [
    {
      registry: "https://registry.example.com",
      name: "@powerhousedao/knowledge",
      version: "1.0.0",
    },
  ],
});

describe("renderCreateActions", () => {
  it("emits initialize, owner, packages, services and approval in order", () => {
    const actions = renderCreateActions({
      label: "Acme vault",
      subdomain: "acme-vault",
      owner: OWNER,
      template,
    });
    expect(types(actions)).toEqual([
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
    const actions = renderCreateActions({
      label: "Browser vault",
      subdomain: "browser-vault",
      owner: OWNER,
      template: {
        ...template,
        services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
        size: null,
      },
    });
    expect(actions.filter((a) => a.type === "ENABLE_SERVICE")).toHaveLength(1);
  });

  it("refuses an unrecognised size rather than silently shrinking the environment", () => {
    expect(() =>
      renderCreateActions({
        label: "Acme vault",
        subdomain: "acme-vault",
        owner: OWNER,
        template: { ...template, size: "XXL" },
      }),
    ).toThrow(UnknownTemplateSizeError);
  });

  // A CLINT service needs a clintConfig the template cannot express, and the
  // environment reducer rejects one without it. Refuse up front instead.
  it("refuses a CLINT service with a named error", () => {
    expect(() =>
      renderCreateActions({
        label: "Agent vault",
        subdomain: "agent-vault",
        owner: OWNER,
        template: {
          ...template,
          services: [{ id: "s3", type: "CLINT", prefix: "agent" }],
        },
      }),
    ).toThrow(UnsupportedTemplateServiceError);
  });

  it("refuses a package with no name rather than skipping it", () => {
    expect(() =>
      renderCreateActions({
        label: "Acme vault",
        subdomain: "acme-vault",
        owner: OWNER,
        template: {
          ...template,
          packages: [{ id: "p1", packageName: null, version: "1.0.0" }],
        },
      }),
    ).toThrow(MissingPackageNameError);
  });
});

describe("renderUpdateActions", () => {
  // The whole point of the split: INITIALIZE only works from DRAFT and SET_OWNER
  // is rejected on an owned environment, so neither may appear on this path.
  it("never replays the create-only actions", () => {
    const actions = renderUpdateActions({
      label: "Acme vault",
      template,
      current: deployedState(),
    });
    expect(types(actions)).not.toContain("INITIALIZE");
    expect(types(actions)).not.toContain("SET_OWNER");
    expect(types(actions)).toEqual(["SET_LABEL", "APPROVE_CHANGES"]);
  });

  it("disables a service the publisher dropped from the template", () => {
    const actions = renderUpdateActions({
      label: "Acme vault",
      template: {
        ...template,
        services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
      },
      current: deployedState(),
    });
    expect(types(actions)).toEqual([
      "SET_LABEL",
      "DISABLE_SERVICE",
      "APPROVE_CHANGES",
    ]);
    expect(actions[1].input).toMatchObject({
      type: "SWITCHBOARD",
      prefix: "switchboard",
    });
  });

  it("removes a package the publisher dropped from the template", () => {
    const actions = renderUpdateActions({
      label: "Acme vault",
      template: { ...template, packages: [] },
      current: deployedState(),
    });
    expect(types(actions)).toEqual([
      "SET_LABEL",
      "REMOVE_PACKAGE",
      "APPROVE_CHANGES",
    ]);
    expect(actions[1].input).toMatchObject({
      packageName: "@powerhousedao/knowledge",
    });
  });

  it("adds what is new and re-pins a changed version", () => {
    const actions = renderUpdateActions({
      label: "Acme vault",
      template: {
        ...template,
        packages: [
          {
            id: "p1",
            packageName: "@powerhousedao/knowledge",
            version: "2.0.0",
          },
          { id: "p2", packageName: "@powerhousedao/vault", version: null },
        ],
      },
      current: deployedState(),
    });
    expect(types(actions)).toEqual([
      "SET_LABEL",
      "ADD_PACKAGE",
      "ADD_PACKAGE",
      "APPROVE_CHANGES",
    ]);
    // An absent version means "latest", which is what the reducer stores.
    expect(actions[2].input).toMatchObject({
      packageName: "@powerhousedao/vault",
      version: "latest",
    });
  });

  it("re-enables a service that was disabled out of band", () => {
    const current = deployedState();
    current.services[0].enabled = false;
    const actions = renderUpdateActions({
      label: "Acme vault",
      template,
      current,
    });
    expect(types(actions)).toEqual([
      "SET_LABEL",
      "ENABLE_SERVICE",
      "APPROVE_CHANGES",
    ]);
  });

  // FUSION is enabled by the app-link flow, not by a licence template, so a
  // template that does not mention it must not tear it down.
  it("leaves a service type the template cannot express alone", () => {
    // CLINT needs a clintConfig the template cannot carry, so it was enabled by
    // something other than a licence template and is not ours to tear down.
    const current = deployedState();
    current.services.push(enabled("CLINT", "clint"));
    const actions = renderUpdateActions({
      label: "Acme vault",
      template,
      current,
    });
    expect(types(actions)).not.toContain("DISABLE_SERVICE");
  });

  // FUSION is template-managed now: dropping the app image from a tier means
  // holders should stop running it.
  it("disables a FUSION service the template no longer asks for", () => {
    const current = deployedState();
    current.services.push(enabled("FUSION", "fusion"));
    const actions = renderUpdateActions({
      label: "Acme vault",
      template,
      current,
    });
    expect(types(actions)).toContain("DISABLE_SERVICE");
  });
});

describe("renderFloorUpdateActions (re-templating a live environment)", () => {
  const fusionTemplate: TemplateShape = {
    ...template,
    services: [
      ...template.services,
      { id: "f", type: "FUSION", prefix: null, resolvedRepository: "registry/app", resolvedVersion: "2.0.0" },
    ],
  };

  it("dispatches nothing when the environment already meets the template", () => {
    expect(renderFloorUpdateActions({ template, current: deployedState() })).toEqual([]);
  });

  it("never sets the label, removes a package or disables a service", () => {
    const current = deployedState();
    current.label = "My own name";
    current.packages.push({ registry: "r", name: "@me/extra", version: "3.0.0" });
    current.services.push(enabled("FUSION", "fusion"));
    const actions = renderFloorUpdateActions({
      template: { ...template, services: [template.services[0]], packages: [] },
      current,
    });
    expect(actions).toEqual([]);
  });

  it("adds missing template packages and enables missing or disabled template services", () => {
    const current = deployedState();
    current.packages = [];
    current.services = [{ ...enabled("CONNECT", "my-prefix"), enabled: false }];
    const actions = renderFloorUpdateActions({ template, current });
    expect(types(actions)).toEqual(["ADD_PACKAGE", "ENABLE_SERVICE", "ENABLE_SERVICE", "APPROVE_CHANGES"]);
    // A disabled service keeps the holder's prefix.
    expect(actions[1].input).toMatchObject({ type: "CONNECT", prefix: "my-prefix" });
    expect(actions[2].input).toMatchObject({ type: "SWITCHBOARD", prefix: "switchboard" });
  });

  it("upgrades an older package and never downgrades a newer or tagged one", () => {
    const older = deployedState();
    older.packages[0].version = "0.9.0";
    expect(types(renderFloorUpdateActions({ template, current: older }))).toEqual(["ADD_PACKAGE", "APPROVE_CHANGES"]);
    const newer = deployedState();
    newer.packages[0].version = "1.2.0";
    expect(renderFloorUpdateActions({ template, current: newer })).toEqual([]);
    const tagged = deployedState();
    tagged.packages[0].version = "dev";
    expect(renderFloorUpdateActions({ template, current: tagged })).toEqual([]);
  });

  it("moves the FUSION image to the template's", () => {
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "fusion"), version: "1.0.0" });
    current.fusion = { image: "registry/app", env: [], autoUpdate: false, autoUpdateTagPattern: null };
    expect(types(renderFloorUpdateActions({ template: fusionTemplate, current }))).toEqual([
      "SET_FUSION_CONFIG", "SET_SERVICE_VERSION", "APPROVE_CHANGES",
    ]);
    current.services[2].version = "2.0.0";
    expect(renderFloorUpdateActions({ template: fusionTemplate, current })).toEqual([]);
  });
});

describe("isVersionUpgrade", () => {
  it.each([
    ["1.0.0", "1.0.1", true],
    ["1.0.0", "1.1.0", true],
    ["1.9.9", "2.0.0", true],
    ["v1.0.0", "1.0.1", true],
    ["1.0.0-beta.1", "1.0.0", true],
    ["1.0.0-beta.1", "1.0.0-beta.2", true],
    ["1.0.0-beta.2", "1.0.0-beta.10", true],
    ["1.0.0-beta", "1.0.0-beta.1", true],
    ["1.0.0-1", "1.0.0-alpha", true],
    ["1.0.0-alpha", "1.0.0-beta", true],
    ["1.0.0", "1.0.0", false],
    ["1.0.1", "1.0.0", false],
    ["2.0.0", "1.9.9", false],
    ["1.0.0", "1.0.0-rc.1", false],
    ["1.0.0-beta.1", "1.0.0-beta", false],
    ["1.0.0-alpha", "1.0.0-1", false],
    ["1.0.0-beta", "1.0.0-alpha", false],
    ["latest", "1.0.0", false],
    ["1.0.0", "latest", false],
    [null, "1.0.0", false],
  ])("%s -> %s is an upgrade: %s", (current, wanted, expected) => {
    expect(isVersionUpgrade(current, wanted)).toBe(expected);
  });
});

describe("validateTemplate", () => {
  it("defaults a service prefix to the lowercased type", () => {
    const n = validateTemplate({
      ...template,
      services: [{ id: "s1", type: "CONNECT", prefix: null }],
    });
    expect(n.services).toEqual([{ type: "CONNECT", prefix: "connect" }]);
  });
});

describe("templateHash", () => {
  // Array order is the only thing JSON.stringify of a template is sensitive to,
  // so reversing both arrays is the test that has teeth.
  it("is stable when the services and packages arrive in the opposite order", () => {
    const reversed: TemplateShape = {
      ...template,
      services: [...template.services].reverse(),
      packages: [...template.packages].reverse(),
    };
    expect(templateHash(reversed)).toBe(templateHash(template));
  });

  it("is stable for two same-type services distinguished only by prefix", () => {
    const t: TemplateShape = {
      ...template,
      services: [
        { id: "a", type: "CONNECT", prefix: "connect" },
        { id: "b", type: "CONNECT", prefix: "studio" },
      ],
    };
    const flipped: TemplateShape = {
      ...t,
      services: [...t.services].reverse(),
    };
    expect(templateHash(flipped)).toBe(templateHash(t));
  });

  it("is stable for two versions of one package", () => {
    const t: TemplateShape = {
      ...template,
      packages: [
        { id: "a", packageName: "@acme/pkg", version: "1.0.0" },
        { id: "b", packageName: "@acme/pkg", version: "2.0.0" },
      ],
    };
    const flipped: TemplateShape = {
      ...t,
      packages: [...t.packages].reverse(),
    };
    expect(templateHash(flipped)).toBe(templateHash(t));
  });

  it("changes when the size changes", () => {
    expect(templateHash({ ...template, size: "VETRA_AGENT_S" })).not.toBe(
      templateHash(template),
    );
  });

  it("changes when a service is added", () => {
    const more: TemplateShape = {
      ...template,
      services: [
        ...template.services,
        { id: "s3", type: "CONNECT", prefix: "studio" },
      ],
    };
    expect(templateHash(more)).not.toBe(templateHash(template));
  });
});
