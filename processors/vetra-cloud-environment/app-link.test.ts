import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// Gitops rendering for App-linked environments (state.app). Standalone envs
// (no `app`) must render byte-identically to before the feature — the golden
// file below was captured from the renderer before `app` existed.

beforeEach(() => {
  vi.stubEnv("FUSION_IMAGE_PROJECTS", "achra");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": {} }) })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const dbStub = {
  selectFrom: () => ({
    select: () => ({
      where: () => ({ executeTakeFirst: async () => undefined }),
    }),
  }),
  insertInto: () => ({ values: () => ({ execute: async () => undefined }) }),
} as unknown as Kysely<DB>;

type Svc = VetraCloudEnvironmentState["services"][number];
const svc = (
  type: Svc["type"],
  prefix: string,
  version: string | null = null,
  selectedRessource: Svc["selectedRessource"] = null,
): Svc => ({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "ACTIVE",
  version,
  config: null,
  selectedRessource,
});

const DOC_ID = "8tgXdfJjDYMkvVpUFqnixKntVDDZ2f4JhU3gDjl3m-w";

function envState(
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: "achra",
    genericSubdomain: "vast-vole-351c8164",
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.vetra.io",
    services: [
      svc("SWITCHBOARD", "switchboard", "v6.2.3-dev.28", "VETRA_AGENT_L"),
      svc("CONNECT", "connect", "v6.2.3-dev.28"),
      svc("FUSION", "fusion", "sha-abc1234def56", "VETRA_AGENT_M"),
    ],
    fusion: {
      image: "cr.vetra.io/achra/frontend",
      env: [{ name: "NEXT_PUBLIC_X", value: "1", isSecret: false }],
      autoUpdate: true,
      autoUpdateTagPattern: null,
    },
    packages: [
      { registry: "https://registry.vetra.io", name: "@achra/pkg", version: "1.2.3" },
    ],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    app: null,
    ...overrides,
  };
}

const render = (state: VetraCloudEnvironmentState) =>
  generateValuesYaml(dbStub, state, DOC_ID, null);

/** Top-level YAML block `key:` until the next top-level key. */
function block(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const PREVIEW_LINK = {
  appId: "app-1",
  role: "PREVIEW" as const,
  prNumber: 42,
  gitRef: "refs/pull/42/merge",
  imageProject: "app-achra",
};

describe("gitops — standalone envs are unchanged", () => {
  it("renders byte-identically to the pre-App renderer (golden)", async () => {
    await expect(await render(envState())).toMatchFileSnapshot(
      "./__golden__/standalone-values.yaml",
    );
  });

  it("treats a document without the `app` key (pre-migration) like app: null", async () => {
    const legacy = envState();
    delete (legacy as Partial<VetraCloudEnvironmentState>).app;
    expect(await render(legacy)).toBe(await render(envState()));
  });

  it("renders a PRODUCTION link exactly like a standalone env when the image is allowlisted", async () => {
    expect(
      await render(
        envState({ app: { ...PREVIEW_LINK, role: "PRODUCTION", prNumber: null } }),
      ),
    ).toBe(await render(envState()));
  });
});

describe("gitops — PREVIEW profile", () => {
  it("shrinks the CNPG database and disables backups", async () => {
    const db = block(await render(envState({ app: PREVIEW_LINK })), "database");
    expect(db).toContain("    storageSize: 5Gi");
    expect(db).not.toContain("storageSize: 50Gi");
    expect(db).toContain('      maxConnections: "100"');
    expect(db).toContain("      sharedBuffers: 128MB");
    expect(db).toMatch(/    backup:\n      enabled: false\n/);
    expect(db).toMatch(
      /      scheduledBackup:\n        enabled: false\n        schedule: [^\n]+\n        immediate: false/,
    );
    expect(db).toContain(
      "      requests:\n        memory: 256Mi\n        cpu: \"50m\"\n      limits:\n        memory: 512Mi\n    bootstrap:",
    );
  });

  it("renders switchboard and FUSION at the smallest size regardless of selection", async () => {
    const yaml = await render(
      envState({
        app: { ...PREVIEW_LINK, imageProject: "achra" },
      }),
    );
    const sb = block(yaml, "switchboard");
    expect(sb).toContain('      cpu: "250m"\n      memory: "512Mi"');
    expect(sb).toContain('      cpu: "1"\n      memory: "1Gi"');
    expect(sb).toContain('"--max-old-space-size=768"');
    const app = block(yaml, "app");
    expect(app).toContain("  enabled: true");
    expect(app).toContain('      cpu: "250m"\n      memory: "512Mi"');
  });

  it("keeps the full production profile for PRODUCTION-linked envs", async () => {
    const db = block(
      await render(envState({ app: { ...PREVIEW_LINK, role: "PRODUCTION" } })),
      "database",
    );
    expect(db).toContain("    storageSize: 50Gi");
    expect(db).toMatch(/    backup:\n      enabled: true\n/);
  });
});

describe("gitops — FUSION allowlist accepts the App's Harbor project (from vetra-apps, not the doc)", () => {
  const appImage = {
    image: "cr.vetra.io/app-achra/app",
    env: [],
    autoUpdate: false,
    autoUpdateTagPattern: null,
  };
  // Stands in for the vetra-apps lookup: only DOC_ID belongs to App app-1.
  const resolver = async (state: VetraCloudEnvironmentState, documentId: string) =>
    state.app?.appId === "app-1" && documentId === DOC_ID ? "app-achra" : null;
  const renderWith = (state: VetraCloudEnvironmentState) =>
    generateValuesYaml(dbStub, state, DOC_ID, null, resolver);

  it("renders the App's project when vetra-apps confirms the link", async () => {
    const app = block(await renderWith(envState({ fusion: appImage, app: PREVIEW_LINK })), "app");
    expect(app).toContain("  enabled: true");
    expect(app).toContain('    repository: "cr.vetra.io/app-achra/app"');
  });

  it("ignores state.app.imageProject: a forged link is rejected", async () => {
    // Without a resolver (or when vetra-apps does not know the link) the doc's
    // own imageProject never widens the allowlist.
    expect(block(await render(envState({ fusion: appImage, app: PREVIEW_LINK })), "app")).toBe(
      "app:\n  enabled: false",
    );
    const forged = { ...PREVIEW_LINK, appId: "app-2" };
    expect(block(await renderWith(envState({ fusion: appImage, app: forged })), "app")).toBe(
      "app:\n  enabled: false",
    );
  });

  it("refuses the project for an env that is not the App's (other document id)", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({ fusion: appImage, app: PREVIEW_LINK }),
      "another-doc-id",
      null,
      resolver,
    );
    expect(block(yaml, "app")).toBe("app:\n  enabled: false");
  });

  it("still refuses that project for a standalone env", async () => {
    const app = block(await renderWith(envState({ fusion: appImage })), "app");
    expect(app).toBe("app:\n  enabled: false");
  });

  it("refuses another App's project", async () => {
    const app = block(
      await renderWith(
        envState({
          fusion: { ...appImage, image: "cr.vetra.io/app-other/app" },
          app: PREVIEW_LINK,
        }),
      ),
      "app",
    );
    expect(app).toBe("app:\n  enabled: false");
  });
});
