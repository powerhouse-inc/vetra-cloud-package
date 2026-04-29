import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// Stub Kysely interactions used by ensureClintAnnounceTokens. CLINT-only paths
// look up an existing token (returning undefined) and would insert a fresh one;
// we make the insert a no-op so we can exercise YAML emission deterministically.
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
