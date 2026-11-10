import { describe, it, expect, vi } from "vitest";
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
  isFusionUpgrade,
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
  // The image cases; the size floor has its own describe below.
  const fusionTemplate: TemplateShape = {
    ...template,
    size: null,
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

  it("moves the FUSION image to the template's, keeping the holder's env, secrets and auto-update", () => {
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "fusion"), version: "1.0.0" });
    current.fusion = {
      image: "registry/old-app",
      env: [{ name: "API_URL", value: "https://x", isSecret: false }, { name: "TOKEN", value: null, isSecret: true }],
      autoUpdate: true,
      autoUpdateTagPattern: "^1\\.",
    };
    const actions = renderFloorUpdateActions({ template: fusionTemplate, current });
    expect(types(actions)).toEqual(["SET_FUSION_CONFIG", "SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
    expect(actions[0].input).toStrictEqual({
      image: "registry/app",
      env: [{ name: "API_URL", value: "https://x", isSecret: false }, { name: "TOKEN", value: null, isSecret: true }],
      autoUpdate: true,
      autoUpdateTagPattern: "^1\\.",
    });
    expect(actions[1].input).toStrictEqual({ type: "FUSION", version: "2.0.0" });
  });

  it("never re-sends the FUSION config when the image matches, and only upgrades its version", () => {
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "fusion"), version: "1.0.0" });
    current.fusion = { image: "registry/app", env: [{ name: "A", value: "1", isSecret: null }], autoUpdate: true, autoUpdateTagPattern: null };
    expect(types(renderFloorUpdateActions({ template: fusionTemplate, current }))).toEqual(["SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
    // The holder runs a newer version than the template: left alone.
    current.services[2].version = "2.1.0";
    expect(renderFloorUpdateActions({ template: fusionTemplate, current })).toEqual([]);
    // Equal: nothing.
    current.services[2].version = "2.0.0";
    expect(renderFloorUpdateActions({ template: fusionTemplate, current })).toEqual([]);
  });

  it("declares the included AI key once, replacing a plain entry of that name (spec 3.11)", () => {
    const KEY = { name: "OPENROUTER_API_KEY", value: null, isSecret: true };
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "fusion"), version: "2.0.0" });
    current.fusion = { image: "registry/app", env: [{ name: "OPENROUTER_API_KEY", value: "x", isSecret: false }], autoUpdate: true, autoUpdateTagPattern: null };
    const actions = renderFloorUpdateActions({ template: fusionTemplate, current, includedKey: true });
    expect(types(actions)).toEqual(["SET_FUSION_CONFIG", "APPROVE_CHANGES"]);
    expect((actions[0].input as { env: unknown[] }).env).toStrictEqual([KEY]);
    // Already declared: nothing to send.
    current.fusion = { ...current.fusion, env: [KEY] };
    expect(renderFloorUpdateActions({ template: fusionTemplate, current, includedKey: true })).toEqual([]);
    // Never removed by a floor without it.
    expect(renderFloorUpdateActions({ template: fusionTemplate, current })).toEqual([]);
  });

  it("sets up a missing FUSION service from scratch", () => {
    const current = deployedState();
    const actions = renderFloorUpdateActions({ template: fusionTemplate, current });
    expect(types(actions)).toEqual(["ENABLE_SERVICE", "SET_FUSION_CONFIG", "SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
    expect(actions[1].input).toStrictEqual({ image: "registry/app", env: [], autoUpdate: false, autoUpdateTagPattern: null });
  });
});

describe("renderFloorUpdateActions moves a FUSION commit tag up by recording order", () => {
  // CI records FUSION builds as commit tags, which semver cannot order. The
  // app's artifact record lists them newest last; that order is the proof.
  const SHA_A = "sha-56e1fd7497fc";
  const SHA_B = "sha-6141b974fc38";
  const shaTemplate: TemplateShape = {
    ...template,
    size: null,
    services: [
      ...template.services,
      { id: "f", type: "FUSION", prefix: "sektar", artifactName: "app", artifactChannel: "LATEST", resolvedRepository: "registry/app", resolvedVersion: SHA_B },
    ],
  };
  const onFusion = (version: string): VetraCloudEnvironmentState => {
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "sektar"), version });
    current.fusion = { image: "registry/app", env: [], autoUpdate: false, autoUpdateTagPattern: null };
    return current;
  };

  it("moves sha-a up to the template's sha-b when sha-b was recorded later", () => {
    const actions = renderFloorUpdateActions({
      template: shaTemplate,
      current: onFusion(SHA_A),
      fusionVersions: [SHA_A, "sha-000000000000", SHA_B],
    });
    expect(types(actions)).toEqual(["SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
    expect(actions[0].input).toStrictEqual({ type: "FUSION", version: SHA_B });
  });

  it("leaves the version alone without a recording order (unchanged behaviour)", () => {
    expect(renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A) })).toEqual([]);
  });

  it("never moves a FUSION version down: current recorded after the template's", () => {
    expect(
      renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), fusionVersions: [SHA_B, SHA_A] }),
    ).toEqual([]);
  });

  it("leaves a version the record does not list alone", () => {
    expect(
      renderFloorUpdateActions({ template: shaTemplate, current: onFusion("sha-ffffffffffff"), fusionVersions: [SHA_A, SHA_B] }),
    ).toEqual([]);
  });

  it("holds a FUSION version the record no longer lists and reports it, never guessing it is older", () => {
    // The vetra-app reducer keeps the last 50 versions: sha-a may have aged
    // out, or the holder may have pinned a newer unrecorded build. Moving it
    // to the template's version could be a downgrade, so it stays.
    const held = vi.fn();
    expect(
      renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), fusionVersions: [SHA_B], onFusionHeld: held }),
    ).toEqual([]);
    expect(held).toHaveBeenCalledExactlyOnceWith({ current: SHA_A, wanted: SHA_B });
  });

  it("reports nothing when the version moves, already matches, or there is no record", () => {
    const held = vi.fn();
    renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), fusionVersions: [SHA_A, SHA_B], onFusionHeld: held });
    renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_B), fusionVersions: [SHA_B], onFusionHeld: held });
    renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), onFusionHeld: held });
    // Neither listed: nothing the record could say either way.
    renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), fusionVersions: ["sha-000000000000"], onFusionHeld: held });
    expect(held).not.toHaveBeenCalled();
  });

  it("reports nothing for two semver versions, which semver orders", () => {
    const held = vi.fn();
    const semverTemplate: TemplateShape = {
      ...shaTemplate,
      services: shaTemplate.services.map((s) => (s.type === "FUSION" ? { ...s, resolvedVersion: "1.0.0" } : s)),
    };
    expect(
      renderFloorUpdateActions({ template: semverTemplate, current: onFusion("2.0.0"), fusionVersions: ["1.0.0"], onFusionHeld: held }),
    ).toEqual([]);
    expect(held).not.toHaveBeenCalled();
  });
});

describe("the template size, a floor for the FUSION service", () => {
  // Sektar cloud environments need 2 GiB (M): at S a Gmail sync was OOM-killed.
  const sized = (size: string | null): TemplateShape => ({
    ...template,
    size,
    services: [
      ...template.services,
      { id: "f", type: "FUSION", prefix: "sektar", resolvedRepository: "registry/app", resolvedVersion: "2.0.0" },
    ],
  });
  const withFusion = (selectedRessource: VetraCloudEnvironmentService["selectedRessource"]) => {
    const current = deployedState();
    current.services.push({ ...enabled("FUSION", "sektar"), version: "2.0.0", selectedRessource });
    current.fusion = { image: "registry/app", env: [], autoUpdate: false, autoUpdateTagPattern: null };
    return current;
  };
  const sizeInputs = (actions: Action[]) =>
    actions.filter((a) => a.type === "SET_SERVICE_SIZE").map((a) => a.input);

  it("starts a new environment's FUSION service at the template size, and nothing else", () => {
    const actions = renderCreateActions({ label: "x", subdomain: "x", owner: OWNER, template: sized("VETRA_AGENT_M") });
    expect(sizeInputs(actions)).toEqual([{ prefix: "sektar", size: "VETRA_AGENT_M" }]);
    const t = types(actions);
    expect(t.indexOf("SET_SERVICE_SIZE")).toBeGreaterThan(t.lastIndexOf("ENABLE_SERVICE") - 1);
  });

  it("leaves the default size when the template names none", () => {
    const actions = renderCreateActions({ label: "x", subdomain: "x", owner: OWNER, template: sized(null) });
    expect(sizeInputs(actions)).toEqual([]);
  });

  it("raises a live environment below the floor, on both update paths", () => {
    for (const current of [withFusion(null), withFusion("VETRA_AGENT_S")]) {
      const floor = renderFloorUpdateActions({ template: sized("VETRA_AGENT_M"), current });
      expect(sizeInputs(floor)).toEqual([{ prefix: "sektar", size: "VETRA_AGENT_M" }]);
      expect(types(floor).at(-1)).toBe("APPROVE_CHANGES");
      const update = renderUpdateActions({ label: "Acme vault", template: sized("VETRA_AGENT_M"), current });
      expect(sizeInputs(update)).toEqual([{ prefix: "sektar", size: "VETRA_AGENT_M" }]);
    }
  });

  it("keeps a size someone raised above the floor, and one already at it", () => {
    for (const size of ["VETRA_AGENT_M", "VETRA_AGENT_L"] as const) {
      const current = withFusion(size);
      expect(sizeInputs(renderFloorUpdateActions({ template: sized("VETRA_AGENT_M"), current }))).toEqual([]);
      expect(sizeInputs(renderUpdateActions({ label: "Acme vault", template: sized("VETRA_AGENT_M"), current }))).toEqual([]);
    }
    expect(renderFloorUpdateActions({ template: sized("VETRA_AGENT_M"), current: withFusion("VETRA_AGENT_M") })).toEqual([]);
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

describe("isFusionUpgrade", () => {
  const recorded = ["sha-aaaaaaaaaaaa", "sha-cccccccccccc", "sha-bbbbbbbbbbbb"];
  it.each([
    ["sha-aaaaaaaaaaaa", "sha-bbbbbbbbbbbb", recorded, true],
    ["sha-bbbbbbbbbbbb", "sha-aaaaaaaaaaaa", recorded, false],
    ["sha-bbbbbbbbbbbb", "sha-bbbbbbbbbbbb", recorded, false],
    ["sha-dddddddddddd", "sha-bbbbbbbbbbbb", recorded, false],
    ["sha-aaaaaaaaaaaa", "sha-dddddddddddd", recorded, false],
    ["sha-aaaaaaaaaaaa", "sha-bbbbbbbbbbbb", undefined, false],
    ["sha-aaaaaaaaaaaa", "sha-bbbbbbbbbbbb", [], false],
    [null, "sha-bbbbbbbbbbbb", recorded, false],
  ] as const)("%s -> %s (recorded %j) is an upgrade: %s", (current, wanted, rec, expected) => {
    expect(isFusionUpgrade(current, wanted, rec)).toBe(expected);
  });

  // Semver pairs are ordered by semver exactly as before, whatever the record says.
  it.each([
    ["1.0.0", "1.0.1"],
    ["1.0.1", "1.0.0"],
    ["1.0.0", "1.0.0"],
    ["1.0.0-beta.1", "1.0.0"],
    ["1.0.0", "1.0.0-rc.1"],
    ["v1.9.9", "2.0.0"],
  ])("%s -> %s follows isVersionUpgrade", (current, wanted) => {
    const expected = isVersionUpgrade(current, wanted);
    expect(isFusionUpgrade(current, wanted, undefined)).toBe(expected);
    expect(isFusionUpgrade(current, wanted, [wanted, current])).toBe(expected);
    expect(isFusionUpgrade(current, wanted, [current, wanted])).toBe(expected);
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

  it("is the same as before the FUSION recording-order fix (no new hashed fields)", () => {
    const fusion: TemplateShape = {
      ...template,
      services: [
        ...template.services,
        { id: "f", type: "FUSION", prefix: "sektar", artifactName: "host", artifactChannel: "LATEST", resolvedRepository: "cr.vetra.io/app-sektar/host", resolvedVersion: "sha-6141b974fc38" },
      ],
    };
    expect(templateHash(template)).toBe("f0ada853ce6b411dcd84809b34e40492f0ff98a94d64b19b060fe82b628b163e");
    expect(templateHash(fusion)).toBe("1023b6cb5e76821b3bd65e8a81835580522bebb545be480ed33306553dd243f9");
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

describe("host templates (a FUSION service whose artifact is `host`)", () => {
  const hostService = {
    id: "h",
    type: "FUSION",
    prefix: "sektar",
    artifactName: "host",
    resolvedRepository: "cr.vetra.io/app-sektar/host",
    resolvedVersion: "sha-abcdef012345",
  };
  // The host settings cases; the size floor has its own describe.
  const hostTemplate: TemplateShape = { ...template, size: null, services: [hostService], packages: [] };
  const fusionEnv = (actions: Action[]) =>
    (actions.find((a) => a.type === "SET_FUSION_CONFIG")?.input as { env: unknown[] } | undefined)?.env;

  it("runs the image as a host with the holder as its admin", () => {
    const actions = renderCreateActions({ label: "Sektar", subdomain: "calm-owl", owner: OWNER, template: hostTemplate });
    expect(fusionEnv(actions)).toEqual([
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
    ]);
  });

  it("leaves an ordinary FUSION image's env empty", () => {
    const app = { ...hostService, artifactName: "app" };
    const actions = renderCreateActions({
      label: "Shop",
      subdomain: "calm-owl",
      owner: OWNER,
      template: { ...template, services: [app], packages: [] },
    });
    expect(fusionEnv(actions)).toEqual([]);
  });

  it("re-adds the host settings on a floor update, keeping the holder's own env", () => {
    const current = deployedState();
    current.services = [{ ...enabled("FUSION", "sektar"), version: "sha-abcdef012345" }];
    current.fusion = {
      image: "cr.vetra.io/app-sektar/host",
      env: [{ name: "FOO", value: "1", isSecret: false }],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    };
    const actions = renderFloorUpdateActions({ template: hostTemplate, current });
    expect(fusionEnv(actions)).toEqual([
      { name: "FOO", value: "1", isSecret: false },
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
    ]);
  });

  it("dispatches nothing when a host env already has its settings", () => {
    const current = deployedState();
    current.services = [{ ...enabled("FUSION", "sektar"), version: "sha-abcdef012345" }];
    current.fusion = {
      image: "cr.vetra.io/app-sektar/host",
      env: [
        { name: "PH_HOST", value: "cli", isSecret: false },
        { name: "ADMINS", value: OWNER, isSecret: false },
      ],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    };
    expect(renderFloorUpdateActions({ template: hostTemplate, current })).toEqual([]);
  });
});

describe("renderCreateActions without an owner", () => {
  it("has no SET_OWNER and an empty ADMINS for a host service", () => {
    const actions = renderCreateActions({
      label: "x (warm)",
      subdomain: "s",
      owner: null,
      template: {
        services: [
          { id: "f", type: "FUSION", prefix: "app", resolvedRepository: "ghcr.io/x/y", resolvedVersion: "1.0.0", artifactName: "host" },
        ],
        packages: [],
        size: "VETRA_AGENT_S",
        baseDomain: null,
        packageRegistry: null,
      },
    });
    expect(types(actions)).not.toContain("SET_OWNER");
    const cfg = actions.find((a) => a.type === "SET_FUSION_CONFIG") as any;
    expect(cfg.input.env).toContainEqual({ name: "ADMINS", value: "", isSecret: false });
  });
});
