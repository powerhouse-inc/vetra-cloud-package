import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// loadClintAnnounceSecret() throws when this is unset — set a deterministic
// test value so YAML rendering for CLINT services works. The actual token
// values asserted in tests are matched against a pattern, not a fixed string.
process.env.CLINT_ANNOUNCE_SECRET = Buffer.from(
  "test-secret-padding-32bytes-ok!!",
).toString("base64");

// DB stub — CLINT tokens no longer touch the DB, but other paths (switchboard,
// connect) may still pass db through; keep a minimal stub so those calls compile.
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
});
