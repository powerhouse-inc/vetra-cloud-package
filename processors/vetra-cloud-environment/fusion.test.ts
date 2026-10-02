import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";
import type { SecretsService } from "../../subgraphs/vetra-cloud-secrets/services/secrets-service.js";

beforeEach(() => {
  vi.stubEnv("FUSION_IMAGE_PROJECTS", "achra,other");
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
const svc = (type: Svc["type"], prefix: string, version: string | null = null): Svc => ({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "ACTIVE",
  version,
  config: null,
  selectedRessource: null,
});

const FUSION_IMAGE = "cr.vetra.io/achra/frontend";
const DOC_ID = "8tgXdfJjDYMkvVpUFqnixKntVDDZ2f4JhU3gDjl3m-w";
const SUB = "vast-vole-351c8164";
const TENANT = "vast-vole-351c8164-8tgxdfjj";

function envState(
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: null,
    label: "achra",
    genericSubdomain: SUB,
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.vetra.io",
    services: [
      svc("SWITCHBOARD", "switchboard"),
      svc("CONNECT", "connect"),
      svc("FUSION", "fusion", "sha-abc1234def56"),
    ],
    fusion: {
      image: FUSION_IMAGE,
      env: [],
      autoUpdate: true,
      autoUpdateTagPattern: null,
    },
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    app: null,
    ...overrides,
  };
}

/** The top-level `app:` block of a values.yaml (until the next top-level key). */
function appBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "app:");
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const render = (state: VetraCloudEnvironmentState, secrets: SecretsService | null = null) =>
  generateValuesYaml(dbStub, state, DOC_ID, secrets);

describe("generateValuesYaml — FUSION", () => {
  it("renders an enabled app block with image, tag, host and platform env", async () => {
    const app = appBlock(await render(envState()));
    expect(app).toContain("  enabled: true");
    expect(app).toContain(`    repository: "${FUSION_IMAGE}"`);
    expect(app).toContain(`    tag: "sha-abc1234def56"`);
    expect(app).toContain(`    host: "${SUB}-fusion.vetra.io"`);
    expect(app).toContain(
      `    "NEXT_PUBLIC_SWITCHBOARD_URL": "https://${SUB}-switchboard.vetra.io/graphql"`,
    );
    expect(app).toContain(`    "NEXT_PUBLIC_CONNECT_URL": "https://${SUB}-connect.vetra.io"`);
    expect(app).toContain(`    "NEXT_PUBLIC_BASE_URL": "https://${SUB}-fusion.vetra.io"`);
    expect(app).toContain(`    "NEXT_PUBLIC_RENOWN_URL": "https://www.renown.id"`);
    expect(app).not.toContain("envFrom");
    expect(app).toContain(`    powerhouse.io/service: fusion`);
    // chunks change content when NEXT_PUBLIC_* change (placeholder swap), so
    // /_next/static must not be cached as immutable for a year
    expect(app).toContain(`  staticCacheMaxAge: 3600`);
  });

  it("omits platform URLs for services the env does not run", async () => {
    const app = appBlock(
      await render(envState({ services: [svc("FUSION", "fusion", "sha-1234567")] })),
    );
    expect(app).toContain("  enabled: true");
    expect(app).not.toContain("NEXT_PUBLIC_SWITCHBOARD_URL");
    expect(app).not.toContain("NEXT_PUBLIC_CONNECT_URL");
  });

  it("renders plain service env inline, overriding a platform default", async () => {
    const app = appBlock(
      await render(
        envState({
          fusion: {
            image: FUSION_IMAGE,
            env: [
              { name: "NEXT_PUBLIC_SHOW_WHITELIST_OVERLAY", value: "false", isSecret: false },
              { name: "NEXT_PUBLIC_RENOWN_URL", value: "https://renown.example", isSecret: false },
            ],
            autoUpdate: false,
            autoUpdateTagPattern: null,
          },
        }),
      ),
    );
    expect(app).toContain(`    "NEXT_PUBLIC_SHOW_WHITELIST_OVERLAY": "false"`);
    expect(app).toContain(`    "NEXT_PUBLIC_RENOWN_URL": "https://renown.example"`);
    expect(app).not.toContain("https://www.renown.id");
  });

  it("never renders secret env inline", async () => {
    const yaml = await render(
      envState({
        fusion: {
          image: FUSION_IMAGE,
          env: [{ name: "MAILCHIMP_API_KEY", value: "leak-me", isSecret: true }],
          autoUpdate: false,
          autoUpdateTagPattern: null,
        },
      }),
    );
    expect(yaml).not.toContain("leak-me");
    // the name is only referenced by key (secretEnv), never as an inline env entry
    expect(appBlock(yaml)).not.toContain(`    "MAILCHIMP_API_KEY":`);
    expect(appBlock(yaml)).toContain(`    - name: "MAILCHIMP_API_KEY"`);
    // the secret reaches the pod via the tenant Secret, so the controller must be on
    expect(yaml).toContain("tenantSecretsController:\n  enabled: true");
  });

  it("disables the app when FUSION has no image or no version", async () => {
    const noImage = appBlock(await render(envState({ fusion: null })));
    expect(noImage).toBe("app:\n  enabled: false");
    const noVersion = appBlock(
      await render(
        envState({
          services: [svc("SWITCHBOARD", "switchboard"), svc("FUSION", "fusion", null)],
        }),
      ),
    );
    expect(noVersion).toBe("app:\n  enabled: false");
  });

  it("disables the app when FUSION is not enabled", async () => {
    const off = { ...svc("FUSION", "fusion", "sha-1234567"), enabled: false };
    const app = appBlock(await render(envState({ services: [svc("SWITCHBOARD", "switchboard"), off] })));
    expect(app).toBe("app:\n  enabled: false");
  });

  it("serves FUSION at the generic apex when it is the apex service", async () => {
    const app = appBlock(await render(envState({ apexService: "FUSION" })));
    expect(app).toContain(`    host: "${SUB}.vetra.io"`);
  });

  it("serves FUSION at the custom domain when it is the apex of an enabled custom domain", async () => {
    const app = appBlock(
      await render(
        envState({
          apexService: "FUSION",
          customDomain: { enabled: true, domain: "achra.com", dnsRecords: [] },
        }),
      ),
    );
    expect(app).toContain(`    host: "achra.com"`);
    expect(app).toContain(`      secretName: fusion-achra-com-tls`);
    expect(app).toContain(`    "NEXT_PUBLIC_BASE_URL": "https://achra.com"`);
  });

  it("passes only the declared secrets, by key, from the tenant Secret", async () => {
    const app = appBlock(
      await render(
        envState({
          fusion: {
            image: FUSION_IMAGE,
            env: [{ name: "MAILCHIMP_API_KEY", value: null, isSecret: true }],
            autoUpdate: false,
            autoUpdateTagPattern: null,
          },
        }),
      ),
    );
    expect(app).toContain("  secretEnv:");
    expect(app).toContain(`    - name: "MAILCHIMP_API_KEY"`);
    expect(app).toContain(`      secretName: ${TENANT}-secrets`);
    expect(app).toContain(`      key: "MAILCHIMP_API_KEY"`);
    expect(app).not.toContain("envFrom");
  });

  it("skips env entries whose name is not a plain identifier", async () => {
    const yaml = await render(
      envState({
        fusion: {
          image: FUSION_IMAGE,
          env: [{ name: 'X: "1"\n  image:', value: "y", isSecret: false }],
          autoUpdate: false,
          autoUpdateTagPattern: null,
        },
      }),
    );
    expect(yaml).not.toContain('X: "1"');
  });

  it("does not render images from Harbor projects outside FUSION_IMAGE_PROJECTS", async () => {
    const app = appBlock(
      await render(
        envState({
          fusion: { image: "cr.vetra.io/vetra/vetra-to", env: [], autoUpdate: false, autoUpdateTagPattern: null },
        }),
      ),
    );
    expect(app).toBe("app:\n  enabled: false");
  });

  it("denies every image when FUSION_IMAGE_PROJECTS is unset", async () => {
    vi.stubEnv("FUSION_IMAGE_PROJECTS", "");
    expect(appBlock(await render(envState()))).toBe("app:\n  enabled: false");
  });
});
