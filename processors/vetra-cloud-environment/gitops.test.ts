import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// generateClintBlock resolves dist-tags -> concrete versions via a registry
// fetch. Stub fetch so the emit tests are deterministic and offline.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        "dist-tags": { latest: "9.9.9", dev: "0.0.1-dev.7" },
      }),
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

// Stub Kysely passed to generateValuesYaml; the CLINT path no longer
// touches the DB after the move to pull-based endpoint discovery.
const dbStub = {
  selectFrom: () => ({
    select: () => ({
      where: () => ({ executeTakeFirst: async () => undefined }),
    }),
  }),
  insertInto: () => ({
    values: () => ({ execute: async () => undefined }),
  }),
} as unknown as Kysely<DB>;

function envState(
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: null,
    label: "test",
    genericSubdomain: "test",
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.dev.vetra.io",
    services: [],
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    ...overrides,
  };
}

describe("generateValuesYaml — switchboard / connect resources", () => {
  it("emits S resources by default when service has no selectedRessource", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: null,
          },
        ],
      }),
      "doc-1",
    );
    expect(yaml).toMatch(
      /switchboard:[\s\S]*?resources:[\s\S]*?requests:[\s\S]*?cpu:\s*"250m"[\s\S]*?memory:\s*"512Mi"[\s\S]*?limits:[\s\S]*?cpu:\s*"1"[\s\S]*?memory:\s*"1Gi"/,
    );
  });

  it("emits L resources when switchboard selectedRessource = VETRA_AGENT_L", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_L",
          },
        ],
      }),
      "doc-2",
    );
    expect(yaml).toMatch(
      /switchboard:[\s\S]*?resources:[\s\S]*?requests:[\s\S]*?cpu:\s*"1"[\s\S]*?memory:\s*"2Gi"[\s\S]*?limits:[\s\S]*?cpu:\s*"4"[\s\S]*?memory:\s*"4Gi"/,
    );
  });

  it("emits XL resources for connect when selectedRessource = VETRA_AGENT_XL", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CONNECT",
            prefix: "connect",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_XL",
          },
        ],
      }),
      "doc-3",
    );
    expect(yaml).toMatch(
      /connect:[\s\S]*?resources:[\s\S]*?requests:[\s\S]*?cpu:\s*"2"[\s\S]*?memory:\s*"4Gi"[\s\S]*?limits:[\s\S]*?cpu:\s*"6"[\s\S]*?memory:\s*"8Gi"/,
    );
  });

  it("emits NODE_OPTIONS sized to ~75% of the pod limit on switchboard", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_M",
          },
        ],
      }),
      "doc-node-m",
    );
    // M = 2Gi limit → max-old-space-size 1536MB
    expect(yaml).toMatch(
      /switchboard:[\s\S]*?env:[\s\S]*?NODE_OPTIONS:\s*"--max-old-space-size=1536"/,
    );
  });

  it("scales NODE_OPTIONS up at XL", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_XL",
          },
        ],
      }),
      "doc-node-xl",
    );
    // XL = 8Gi limit → 6144MB
    expect(yaml).toMatch(
      /switchboard:[\s\S]*?env:[\s\S]*?NODE_OPTIONS:\s*"--max-old-space-size=6144"/,
    );
  });

  it("emits NODE_OPTIONS on connect too", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CONNECT",
            prefix: "connect",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_L",
          },
        ],
      }),
      "doc-node-connect",
    );
    // L = 4Gi limit → 3072MB
    expect(yaml).toMatch(
      /connect:[\s\S]*?env:[\s\S]*?NODE_OPTIONS:\s*"--max-old-space-size=3072"/,
    );
  });

  it("emits NODE_OPTIONS for CLINT pods sized to the t-shirt", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CLINT",
            prefix: "agent",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            selectedRessource: "VETRA_AGENT_M",
            config: {
              package: { registry: "https://r", name: "p", version: "1.0.0" },
              env: [],
              serviceCommand: null,
              selectedRessource: null,
            },
          },
        ],
      }),
      "doc-clint-node",
    );
    // CLINT_M has nodeMaxOldSpaceMb = 768
    expect(yaml).toMatch(
      /clint:[\s\S]*?env:[\s\S]*?NODE_OPTIONS[\s\S]*?--max-old-space-size=768/,
    );
  });

  const clintService = {
    type: "CLINT" as const,
    prefix: "agent",
    enabled: true,
    url: null,
    status: "ACTIVE" as const,
    version: null,
    selectedRessource: "VETRA_AGENT_M" as const,
    config: {
      package: { registry: "https://r", name: "p", version: "1.0.0" },
      env: [],
      serviceCommand: null,
      selectedRessource: null,
    },
  };

  it("renders a warm CLINT agent with ingress enabled and no network-lock field", async () => {
    // The network lock was removed (it never enforced — Traefik hostNetwork
    // traffic bypassed the default-deny policy). Unclaimed agents keep their
    // warm ingress and are gated by auth + the credential guard instead.
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ owner: null, services: [clintService] }),
      "doc-clint-warm",
    );
    expect(yaml).toMatch(/ingress:[\s\S]*?enabled: true/);
    expect(yaml).not.toMatch(/locked:/);
  });

  it("preserves user-provided env vars alongside NODE_OPTIONS for CLINT", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CLINT",
            prefix: "agent",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            selectedRessource: "VETRA_AGENT_S",
            config: {
              package: { registry: "https://r", name: "p", version: "1.0.0" },
              env: [{ name: "FOO", value: "bar" }],
              serviceCommand: null,
              selectedRessource: null,
            },
          },
        ],
      }),
      "doc-clint-userenv",
    );
    expect(yaml).toMatch(/NODE_OPTIONS[\s\S]*?--max-old-space-size=384/);
    expect(yaml).toMatch(/name: "FOO", value: "bar"/);
  });

  it("falls back to legacy CLINT config.selectedRessource when top-level absent", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CLINT",
            prefix: "agent",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            selectedRessource: null,
            config: {
              package: {
                registry: "https://r.example",
                name: "p",
                version: "1.0.0",
              },
              env: [],
              serviceCommand: null,
              selectedRessource: "VETRA_AGENT_M",
            },
          },
        ],
      }),
      "doc-4",
    );
    // CLINT_M from existing CLINT_RESOURCE_MAP: requests 250m/512Mi, limits 1/1Gi
    expect(yaml).toMatch(
      /clint:[\s\S]*?requests:\s*\{\s*cpu:\s*"250m",\s*memory:\s*"512Mi"\s*\}/,
    );
  });

  it("emits CLINT XXL with cpu request 2 and cpu limit 4 (Vetra Studio sizing)", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CLINT",
            prefix: "vetra-agent",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            selectedRessource: "VETRA_AGENT_XXL",
            config: {
              package: { registry: "https://r", name: "p", version: "1.0.0" },
              env: [],
              serviceCommand: null,
              selectedRessource: null,
            },
          },
        ],
      }),
      "doc-clint-xxl",
    );
    expect(yaml).toMatch(
      /clint:[\s\S]*?requests:\s*\{\s*cpu:\s*"2",\s*memory:\s*"4Gi"\s*\}[\s\S]*?limits:\s*\{\s*cpu:\s*"4",\s*memory:\s*"8Gi"\s*\}/,
    );
  });
});

describe("generateValuesYaml — vetra-cli switchboard auth env", () => {
  function clintAgent(pkgName: string) {
    return {
      type: "CLINT" as const,
      prefix: "agent",
      enabled: true,
      url: null,
      status: "ACTIVE" as const,
      version: null,
      selectedRessource: "VETRA_AGENT_M" as const,
      config: {
        package: { registry: "https://r", name: pkgName, version: "1.0.0" },
        env: [],
        serviceCommand: null,
        selectedRessource: null,
      },
    };
  }

  it("emits the auth env set on a vetra-cli agent with a non-null owner", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        owner: "0xABCdef0000000000000000000000000000001234",
        services: [clintAgent("vetra-cli")],
      }),
      "doc-auth-owner",
    );
    expect(yaml).toMatch(/name: "AUTH_ENABLED", value: "true"/);
    expect(yaml).toMatch(/name: "DOCUMENT_PERMISSIONS_ENABLED", value: "true"/);
    expect(yaml).toMatch(/name: "DEFAULT_PROTECTION", value: "true"/);
    // No SKIP_CREDENTIAL_VERIFICATION: the studio's embedded switchboard does the
    // real Renown credential check (like the management switchboard). vetra-cli's
    // bundled switchboard refuses the skip flag in production, so emitting it
    // crash-loops a claimed studio.
    expect(yaml).not.toMatch(/SKIP_CREDENTIAL_VERIFICATION/);
    // owner lowercased into ADMINS
    expect(yaml).toMatch(
      /name: "ADMINS", value: "0xabcdef0000000000000000000000000000001234"/,
    );
  });

  it("does NOT emit auth env on a non-vetra-cli CLINT agent", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        owner: "0xABCdef0000000000000000000000000000001234",
        services: [clintAgent("some-other-agent")],
      }),
      "doc-auth-other",
    );
    expect(yaml).not.toMatch(/AUTH_ENABLED/);
  });

  it("does NOT emit auth env on the standalone switchboard service block", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        owner: "0xABCdef0000000000000000000000000000001234",
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: null,
          },
        ],
      }),
      "doc-auth-switchboard",
    );
    expect(yaml).not.toMatch(/AUTH_ENABLED/);
  });

  it("omits ADMINS when owner is null but still enables auth on vetra-cli", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ owner: null, services: [clintAgent("vetra-cli")] }),
      "doc-auth-noowner",
    );
    expect(yaml).toMatch(/name: "AUTH_ENABLED", value: "true"/);
    expect(yaml).not.toMatch(/name: "ADMINS"/);
  });
});

describe("generateValuesYaml — CLINT prebuilt agent image", () => {
  function clintState(pkgName: string, version: string) {
    return envState({
      services: [
        {
          type: "CLINT",
          prefix: "agent",
          enabled: true,
          url: null,
          status: "ACTIVE",
          version: null,
          selectedRessource: "VETRA_AGENT_S",
          config: {
            package: {
              registry: "https://registry.dev.vetra.io",
              name: pkgName,
              version,
            },
            env: [],
            serviceCommand: null,
            selectedRessource: null,
          },
        },
      ],
    });
  }

  it("emits the per-agent prebuilt image repo with the scoped name sanitized", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      clintState("@powerhousedao/ph-pirate-cli", "0.0.1-dev.1"),
      "doc-prebuilt-scoped",
    );
    expect(yaml).toContain(
      'repository: "cr.vetra.io/powerhouse-inc-powerhouse/clint-agent/powerhousedao-ph-pirate-cli"',
    );
    expect(yaml).toMatch(/clint:[\s\S]*?tag: "0\.0\.1-dev\.1"/);
  });

  it("uses IfNotPresent and no longer points at the generic clint-runtime image", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      clintState("p", "1.2.3"),
      "doc-prebuilt-pullpolicy",
    );
    expect(yaml).toMatch(/clint:[\s\S]*?pullPolicy: IfNotPresent/);
    expect(yaml).not.toMatch(/repository: ".*\/clint-runtime"/);
  });

  it("resolves a 'latest' dist-tag to the concrete version for tag + version", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      clintState("@x/foo-cli", "latest"),
      "doc-prebuilt-latest",
    );
    // stubbed registry: dist-tags.latest = 9.9.9
    expect(yaml).toMatch(/clint:[\s\S]*?tag: "9\.9\.9"/);
    expect(yaml).toMatch(/clint:[\s\S]*?version: "9\.9\.9"/);
    expect(yaml).not.toMatch(/clint:[\s\S]*?tag: "latest"/);
  });

  it("emits a per-agent storage size so the chart provisions a persistent volume", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      clintState("vetra-cli", "0.0.1-dev.23"),
      "doc-clint-storage",
    );
    expect(yaml).toMatch(/clint:[\s\S]*?storage: "2Gi"/);
  });
});

describe("generateValuesYaml — connect runtime config", () => {
  const connectService = {
    type: "CONNECT" as const,
    prefix: "connect",
    enabled: true,
    url: null,
    status: "PROVISIONING" as const,
    version: null,
    config: null,
    selectedRessource: null,
  };

  // Pull the rendered PH_CONNECT_CONFIG_JSON env value back out of the YAML
  // and parse it, so assertions work on the payload object instead of on
  // escaped-string internals.
  function readConnectConfigPayload(yaml: string): Record<string, unknown> {
    const match = /PH_CONNECT_CONFIG_JSON: "((?:[^"\\]|\\.)*)"/.exec(yaml);
    expect(match).not.toBeNull();
    const unquoted = match![1].replace(/\\(["\\])/g, "$1");
    return JSON.parse(unquoted) as Record<string, unknown>;
  }

  it("renders the stored runtime config as the PH_CONNECT_CONFIG_JSON payload", async () => {
    const runtimeConfig = JSON.stringify({
      connect: { app: { logLevel: "debug" } },
      packageRegistryUrl: "https://registry.example/-/cdn/",
    });
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ services: [connectService], runtimeConfig }),
      "doc-connect-config",
    );

    expect(readConnectConfigPayload(yaml)).toEqual({
      connect: { app: { logLevel: "debug" } },
      packageRegistryUrl: "https://registry.example/-/cdn/",
    });
  });

  it("composes state.packages into the payload's top-level packages array", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [connectService],
        runtimeConfig: null,
        packages: [
          {
            name: "@memo/builder-profile",
            version: "1.1.0-dev.24",
            registry: "https://registry.dev.vetra.io",
          },
        ],
      }),
      "doc-connect-pkgs",
    );

    expect(readConnectConfigPayload(yaml)).toEqual({
      packages: [
        { packageName: "@memo/builder-profile", version: "1.1.0-dev.24" },
      ],
      packageRegistryUrl: "https://registry.dev.vetra.io",
    });
  });

  it("combines runtime-config overrides and installed packages in one payload", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [connectService],
        runtimeConfig: JSON.stringify({
          connect: { branding: { appName: "Powerhouse Connect runtime" } },
        }),
        packages: [
          {
            name: "@memo/builder-profile",
            version: "1.1.0-dev.24",
            registry: "https://registry.dev.vetra.io",
          },
        ],
      }),
      "doc-connect-combined",
    );

    expect(readConnectConfigPayload(yaml)).toEqual({
      connect: { branding: { appName: "Powerhouse Connect runtime" } },
      packages: [
        { packageName: "@memo/builder-profile", version: "1.1.0-dev.24" },
      ],
      packageRegistryUrl: "https://registry.dev.vetra.io",
    });
  });

  it("state.packages wins over a packages key smuggled into runtimeConfig", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [connectService],
        runtimeConfig: JSON.stringify({
          packages: [{ packageName: "@evil/stale", version: "0.0.1" }],
        }),
        packages: [
          {
            name: "@memo/builder-profile",
            version: "1.1.0-dev.24",
            registry: "https://registry.dev.vetra.io",
          },
        ],
      }),
      "doc-connect-precedence",
    );

    const payload = readConnectConfigPayload(yaml);
    expect(payload.packages).toEqual([
      { packageName: "@memo/builder-profile", version: "1.1.0-dev.24" },
    ]);
  });

  it("omits the version field for packages without one and keeps an operator packageRegistryUrl", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [connectService],
        runtimeConfig: JSON.stringify({
          packageRegistryUrl: "https://registry.example/-/cdn/",
        }),
        packages: [
          {
            name: "@memo/builder-profile",
            version: null,
            registry: "https://registry.dev.vetra.io",
          },
        ],
      }),
      "doc-connect-noversion",
    );

    expect(readConnectConfigPayload(yaml)).toEqual({
      packageRegistryUrl: "https://registry.example/-/cdn/",
      packages: [{ packageName: "@memo/builder-profile" }],
    });
  });

  it("omits PH_CONNECT_CONFIG_JSON when null and no packages", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ services: [connectService], runtimeConfig: null }),
      "doc-connect-null",
    );
    expect(yaml).not.toContain("PH_CONNECT_CONFIG_JSON");
  });

  it("omits PH_CONNECT_CONFIG_JSON when an empty-object string and no packages", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ services: [connectService], runtimeConfig: "{}" }),
      "doc-connect-empty",
    );
    expect(yaml).not.toContain("PH_CONNECT_CONFIG_JSON");
  });
});

describe("generateValuesYaml — tenant cluster issuer (ZeroSSL routing)", () => {
  const issuerEnv = "TENANT_CLUSTER_ISSUER";
  afterEach(() => {
    delete process.env[issuerEnv];
  });

  const clintAndSwitchboard = (): Partial<VetraCloudEnvironmentState> => ({
    services: [
      {
        type: "CLINT",
        prefix: "vetra-agent",
        enabled: true,
        url: null,
        status: "ACTIVE",
        version: null,
        selectedRessource: "VETRA_AGENT_S",
        config: {
          package: { registry: "https://r", name: "p", version: "1.0.0" },
          env: [],
          serviceCommand: null,
          selectedRessource: null,
        },
      },
      {
        type: "SWITCHBOARD",
        prefix: "switchboard",
        enabled: true,
        url: null,
        status: "ACTIVE",
        version: null,
        selectedRessource: "VETRA_AGENT_S",
        config: null,
      },
    ],
  });

  it("defaults to letsencrypt-prod when TENANT_CLUSTER_ISSUER is unset", async () => {
    const yaml = await generateValuesYaml(dbStub, envState(clintAndSwitchboard()), "doc-issuer-default");
    expect(yaml).toContain(`certClusterIssuer: "letsencrypt-prod"`);
    expect(yaml).toMatch(/cert-manager\.io\/cluster-issuer: letsencrypt-prod/);
    expect(yaml).not.toContain("zerossl-prod");
  });

  it("routes clint + switchboard certs to the configured issuer (zerossl-prod)", async () => {
    process.env[issuerEnv] = "zerossl-prod";
    const yaml = await generateValuesYaml(dbStub, envState(clintAndSwitchboard()), "doc-issuer-zerossl");
    // clint block carries it for the chart's clint-ingress template...
    expect(yaml).toContain(`certClusterIssuer: "zerossl-prod"`);
    // ...and the switchboard ingress annotation uses it inline.
    expect(yaml).toMatch(/cert-manager\.io\/cluster-issuer: zerossl-prod/);
    expect(yaml).not.toMatch(/cluster-issuer: letsencrypt-prod/);
  });
});
