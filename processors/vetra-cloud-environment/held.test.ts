import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

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

const DOC_ID = "8tgXdfJjDYMkvVpUFqnixKntVDDZ2f4JhU3gDjl3m-w";
const SUB = "fair-ibis-huk51fts";

function envState(
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: null,
    ownerOrgId: null,
    orgOperators: [],
    label: "sektar",
    genericSubdomain: SUB,
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.vetra.io",
    services: [svc("FUSION", "fusion", "sha-d5a6f74abbf3")],
    fusion: {
      image: "cr.vetra.io/achra/host",
      env: [{ name: "PH_HOST", value: "cli", isSecret: false }],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    },
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    backupSchedule: null,
    managedBy: null,
    app: null,
    ...overrides,
  };
}

/** A top-level block of a values.yaml (until the next top-level key). */
function block(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const render = (
  state: VetraCloudEnvironmentState,
  held: boolean | (() => Promise<boolean>),
  isWarm: (() => Promise<{ appId: string } | null>) | null = null,
) =>
  generateValuesYaml(
    dbStub,
    state,
    DOC_ID,
    null,
    null,
    isWarm,
    typeof held === "function" ? held : async () => held,
  );

describe("a held FUSION host (database-backed licensed environment)", () => {
  it("keeps its database, pooler, backups and /data, and runs no app and no ingress", async () => {
    const yaml = await render(envState(), true);
    const app = block(yaml, "app");
    // app.enabled stays true: the chart renders the CNPG Cluster, Pooler and
    // ScheduledBackup only with (app.enabled and app.database.enabled), and
    // the /data PVC only with app.enabled.
    expect(app).toContain("  enabled: true");
    expect(app).toContain("  replicaCount: 0");
    expect(app).toMatch(/  ingress:\n    enabled: false/);
    expect(app).not.toContain("closed:");
    expect(app).toContain("  database:\n    enabled: true");
    expect(app).toContain("  persistence:\n    enabled: true");
    expect(yaml).toContain("global:\n  disabled: false");
    expect(yaml).toMatch(/^database:\n  cnpg:\n    enabled: true/m);
    expect(yaml).toMatch(/    pooler:\n      enabled: true/);
    expect(yaml).toMatch(/    backup:\n      enabled: true/);
    expect(yaml).toMatch(/      scheduledBackup:\n        enabled: true/);
    await expect(yaml).toMatchFileSnapshot("./__golden__/held-values.yaml");
  });

  it("is exactly the normal render without a hold", async () => {
    const plain = await generateValuesYaml(dbStub, envState(), DOC_ID);
    expect(await render(envState(), false)).toBe(plain);
    expect(block(plain, "app")).toContain("  replicaCount: 1");
    expect(block(plain, "app")).toMatch(/  ingress:\n    enabled: true/);
  });

  it("a held STOPPED environment is still disabled (a hold never wakes)", async () => {
    const yaml = await render(envState({ status: "STOPPED" }), true);
    expect(yaml).toContain("global:\n  disabled: true");
  });

  it("a held warm environment has no ingress at all (the hold wins over closed)", async () => {
    const yaml = await render(envState(), true, async () => ({ appId: "a" }));
    const app = block(yaml, "app");
    expect(app).toMatch(/  ingress:\n    enabled: false/);
    expect(app).not.toContain("closed:");
    expect(app).toContain("  replicaCount: 0");
  });

  it("a FUSION host on a custom domain apex loses that ingress too", async () => {
    const yaml = await render(
      envState({
        customDomain: { enabled: true, domain: "holder.example", dnsRecords: [] },
        apexService: "FUSION",
      }),
      true,
    );
    expect(block(yaml, "app")).toMatch(/  ingress:\n    enabled: false/);
  });
});

describe("a held FUSION host whose image is not vouched for this render", () => {
  // An allowlist or vetra-apps hiccup must never drop the CNPG cluster of a
  // held environment: a held app runs no pod, so it pulls no image.
  it("still keeps its database at 0 replicas when FUSION_IMAGE_PROJECTS is missing its project", async () => {
    const vouched = await render(envState(), true);
    vi.stubEnv("FUSION_IMAGE_PROJECTS", "");
    const yaml = await render(envState(), true);
    const app = block(yaml, "app");
    expect(app).toContain("  enabled: true");
    expect(app).toContain("  replicaCount: 0");
    expect(app).toMatch(/  ingress:\n    enabled: false/);
    expect(app).toContain("  database:\n    enabled: true");
    expect(yaml).toMatch(/^database:\n  cnpg:\n    enabled: true/m);
    expect(yaml).toBe(vouched);
  });

  it("an unheld one is still not rendered (app disabled), as before", async () => {
    vi.stubEnv("FUSION_IMAGE_PROJECTS", "");
    const yaml = await render(envState(), false);
    expect(block(yaml, "app")).toBe("app:\n  enabled: false");
  });

  it("a held one without any image stays disabled (it never had a database)", async () => {
    const yaml = await render(
      envState({
        fusion: {
          image: null as unknown as string,
          env: [],
          autoUpdate: false,
          autoUpdateTagPattern: null,
        },
      }),
      true,
    );
    expect(block(yaml, "app")).toBe("app:\n  enabled: false");
  });
});

describe("a held switchboard environment", () => {
  const sbState = () =>
    envState({
      services: [svc("SWITCHBOARD", "switchboard"), svc("CONNECT", "connect")],
      fusion: null,
      customDomain: { enabled: true, domain: "holder.example", dnsRecords: [] },
    });

  it("keeps the switchboard (and so the database and attachments volume) at 0 replicas, with no ingress; Connect is off", async () => {
    const yaml = await render(sbState(), true);
    const sb = block(yaml, "switchboard");
    expect(sb).toContain("  enabled: true");
    expect(sb).toContain("  replicaCount: 0");
    expect(sb).toMatch(/  ingress:\n    enabled: false/);
    // the custom-domain ingresses are rendered whenever the service is on
    expect(sb).not.toContain("additionalIngresses");
    expect(block(yaml, "connect")).toMatch(/^connect:\n  enabled: false/);
    expect(yaml).toMatch(/^database:\n  cnpg:\n    enabled: true/m);
    expect(yaml).toContain("global:\n  disabled: false");
  });

  it("renders the switchboard normally without a hold", async () => {
    const yaml = await render(sbState(), false);
    expect(block(yaml, "switchboard")).toContain("  replicaCount: 1");
    expect(block(yaml, "switchboard")).toContain("additionalIngresses");
    expect(block(yaml, "connect")).toMatch(/^connect:\n  enabled: true/);
  });
});

describe("hold lookup failures", () => {
  it("renders as not held when the holds table does not exist yet (42P01)", async () => {
    const yaml = await render(envState(), async () => {
      throw Object.assign(new Error('relation "environment_holds" does not exist'), {
        code: "42P01",
      });
    });
    expect(yaml).toBe(await generateValuesYaml(dbStub, envState(), DOC_ID));
  });

  it("fails the render on any other error (a held environment never starts by accident)", async () => {
    await expect(
      render(envState(), async () => {
        throw Object.assign(new Error("connection reset"), { code: "08006" });
      }),
    ).rejects.toThrow("connection reset");
  });

  it("asks once per render, by document id", async () => {
    const isHeld = vi.fn(async () => true);
    await render(envState(), isHeld);
    expect(isHeld).toHaveBeenCalledTimes(1);
    expect(isHeld).toHaveBeenCalledWith(DOC_ID);
  });
});
