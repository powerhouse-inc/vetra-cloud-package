import {
  buildASTSchema,
  graphql,
  Kind,
  parse,
  type GraphQLObjectType,
} from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_ONLY_ACCESS } from "../../vetra-cloud-observability/env-access.js";
import type { TenantOwnersResult } from "../../../shared/tenant-owners.js";
import { createLlmBroker } from "../broker.js";
import { DEFAULT_STUDIO_MODEL } from "../config.js";
import { createLlmResolvers, type LlmResolverDeps } from "../resolvers.js";
import { createLlmKeyStore } from "../store.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createProcessBroker } from "../factory.js";
import { schema } from "../schema.js";
import { createFakeSecrets, fakeKeyVault } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TENANT = "warm-newt-75-aa726a95";
const ENV = "aa726a95-1111-2222-3333-444455556666";
const STUDIO = {
  packages: [
    { name: "vetra", registry: "https://registry.vetra.io", version: "1" },
  ],
};
const asUser = (address: string) => ({ user: { address } });

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

type R = {
  VetraLlmQueries: Record<
    string,
    (p: unknown, a: object, c: object) => Promise<unknown>
  >;
  VetraLlmMutations: Record<
    string,
    (p: unknown, a: object, c: object) => Promise<unknown>
  >;
};

async function setup(over: Partial<LlmResolverDeps> = {}, budgetUsd = 20) {
  const h = await openLlmDb();
  destroy = h.destroy;
  const fake = createFakeOpenRouter();
  const secrets = createFakeSecrets();
  const store = createLlmKeyStore(h.db);
  const broker = createLlmBroker({
    store,
    openrouter: fake.api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid: async () => ({ allowed: true, budgetUsd }),
    cfg: { defaultModel: DEFAULT_STUDIO_MODEL, workspaceId: null },
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const r = createLlmResolvers({
    broker,
    tenantOwners: async (): Promise<TenantOwnersResult> => ({
      ok: true,
      owners: [OWNER],
    }),
    envIdsByTenant: async (t) => (t === TENANT ? [ENV] : []),
    envRow: async (id) =>
      id === ENV
        ? { owner: OWNER, ownerOrgId: null, appId: null, tenantId: TENANT }
        : null,
    envState: async (id) => (id === ENV ? (STUDIO as never) : null),
    keyStatus: async (id) => (await store.get(id))?.status ?? null,
    access: OWNER_ONLY_ACCESS,
    secrets,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  }) as unknown as R;
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: { extensions?: { code?: unknown } }) => e.extensions?.code,
    );
  return { r, fake, secrets, code, store };
}

describe("provisionStudioLlm", () => {
  it("provisions the caller's Studio key and the session-export secret", async () => {
    const s = await setup();
    const res = await s.r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
    expect(res).toStrictEqual({
      environmentId: ENV,
      connected: true,
      llmBudgetUsd: 20,
    });
    expect(s.secrets.secret(TENANT, "OPENROUTER_API_KEY")).toMatch(/^sk-or-/);
    expect(s.secrets.secret(TENANT, "VETRA_SESSION_EXPORT_SECRET")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("finishes without a key when the licence has no budget", async () => {
    const s = await setup({}, 0);
    const res = await s.r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
    expect(res).toStrictEqual({
      environmentId: ENV,
      connected: false,
      llmBudgetUsd: 0,
    });
    expect(s.fake.keys.size).toBe(0);
    expect(s.secrets.secret(TENANT, "VETRA_SESSION_EXPORT_SECRET")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("refuses anonymous callers, other owners, unknown tenants and non-Studios, minting nothing", async () => {
    const s = await setup();
    const m = s.r.VetraLlmMutations.provisionStudioLlm;
    expect(await s.code(m({}, { tenantId: TENANT }, {}))).toBe(
      "UNAUTHENTICATED",
    );
    expect(await s.code(m({}, { tenantId: TENANT }, asUser(STRANGER)))).toBe(
      "FORBIDDEN",
    );
    const unknown = await setup({
      tenantOwners: async () => ({ ok: false, reason: "UNKNOWN" }),
    });
    expect(
      await unknown.code(
        unknown.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: "nope" },
          asUser(OWNER),
        ),
      ),
    ).toBe("NOT_FOUND");
    const busy = await setup({
      tenantOwners: async () => ({ ok: false, reason: "BUSY" }),
    });
    expect(
      await busy.code(
        busy.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: TENANT },
          asUser(OWNER),
        ),
      ),
    ).toBe("FORBIDDEN");
    const plain = await setup({
      envState: async () => ({ packages: [{ name: "other" }] }) as never,
    });
    expect(
      await plain.code(
        plain.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: TENANT },
          asUser(OWNER),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(s.fake.keys.size + plain.fake.keys.size).toBe(0);
  });
});

describe("studioLlmStatus and studioLlmUsage", () => {
  it("reports whether the Studio has a model key, for its operator only", async () => {
    const s = await setup();
    const status = s.r.VetraLlmQueries.studioLlmStatus;
    expect(
      await status({}, { environmentId: ENV }, asUser(OWNER)),
    ).toStrictEqual({ environmentId: ENV, connected: false });
    await s.r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
    expect(
      await status({}, { environmentId: ENV }, asUser(OWNER)),
    ).toStrictEqual({ environmentId: ENV, connected: true });
    expect(
      await s.code(status({}, { environmentId: ENV }, asUser(STRANGER))),
    ).toBe("FORBIDDEN");
    expect(
      await s.code(status({}, { environmentId: "nope" }, asUser(OWNER))),
    ).toBe("NOT_FOUND");
  });

  it("returns usage for the operator and null without a key", async () => {
    const s = await setup();
    const usage = s.r.VetraLlmQueries.studioLlmUsage;
    expect(await usage({}, { environmentId: ENV }, asUser(OWNER))).toBeNull();
    await s.r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
    expect(
      await usage({}, { environmentId: ENV }, asUser(OWNER)),
    ).toMatchObject({ source: "VETRA", limitUsd: 20, usageUsd: 0 });
    expect(
      await s.code(usage({}, { environmentId: ENV }, asUser(STRANGER))),
    ).toBe("FORBIDDEN");
  });
});

describe("session-export secret", () => {
  it("is written once and never rotated by a repeat call", async () => {
    const s = await setup();
    const m = s.r.VetraLlmMutations.provisionStudioLlm;
    await m({}, { tenantId: TENANT }, asUser(OWNER));
    const first = s.secrets.secret(TENANT, "VETRA_SESSION_EXPORT_SECRET");
    await m({}, { tenantId: TENANT }, asUser(OWNER));
    expect(s.secrets.secret(TENANT, "VETRA_SESSION_EXPORT_SECRET")).toBe(first);
  });
});

/** The subgraph SDL plus a base Query/Mutation, with the resolver map bound field by field. */
function compose(resolvers: Record<string, unknown>) {
  const sdl = buildASTSchema({
    kind: Kind.DOCUMENT,
    definitions: [
      ...parse("type Query { _: Boolean } type Mutation { _: Boolean }")
        .definitions,
      ...schema.definitions,
    ],
  });
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const t = sdl.getType(typeName) as GraphQLObjectType;
    for (const [f, fn] of Object.entries(fields as Record<string, never>))
      t.getFields()[f].resolve = fn;
  }
  return sdl;
}

describe("composed schema", () => {
  const QUERY = `query { vetraLlm { studioLlmStatus(environmentId: "${ENV}") { environmentId connected }
    studioLlmUsage(environmentId: "${ENV}") { source model usageUsd limitUsd resetsAt } } }`;
  const MUTATION = `mutation { vetraLlm { provisionStudioLlm(tenantId: "${TENANT}") { environmentId connected llmBudgetUsd } } }`;

  it("never leaks key material through any query or mutation", async () => {
    const s = await setup();
    const composed = compose({
      Query: { vetraLlm: () => ({}) },
      Mutation: { vetraLlm: () => ({}) },
      VetraLlmQueries: s.r.VetraLlmQueries,
      VetraLlmMutations: s.r.VetraLlmMutations,
    });
    const contextValue = asUser(OWNER);
    const out: string[] = [];
    for (const source of [QUERY, MUTATION, QUERY]) {
      const res = await graphql({ schema: composed, source, contextValue });
      expect(res.errors).toBeUndefined();
      out.push(JSON.stringify(res));
    }
    expect(out[1]).toContain('"connected":true');
    expect(out[2]).toContain('"usageUsd"');
    for (const json of out) {
      expect(json).not.toContain("key_ciphertext");
      expect(json).not.toContain("vault:");
      expect(json).not.toContain("sk-or-");
    }
  });

  it("redacts an upstream error carrying a key in the client message", async () => {
    const leak = vi.fn(async () => {
      throw new Error("upstream said sk-or-v1-leak and vault:v1:abcdef");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failing = await setup({
      logger,
      broker: {
        provisionVetraKey: leak,
        studioLlmUsage: leak,
      } as never,
    });
    const composed = compose({
      Query: { vetraLlm: () => ({}) },
      Mutation: { vetraLlm: () => ({}) },
      VetraLlmQueries: failing.r.VetraLlmQueries,
      VetraLlmMutations: failing.r.VetraLlmMutations,
    });
    for (const source of [MUTATION, QUERY]) {
      const res = await graphql({
        schema: composed,
        source,
        contextValue: asUser(OWNER),
      });
      const text = JSON.stringify(res);
      expect(res.errors?.length).toBeGreaterThan(0);
      expect(text).not.toContain("sk-or-v1-leak");
      expect(text).not.toContain("vault:");
    }
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "sk-or-v1-leak",
    );
  });

  it("maps an OpenRouter failure to a clean UPSTREAM_ERROR", async () => {
    const s = await setup();
    s.fake.failNext("createKey", 500);
    expect(
      await s.code(
        s.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: TENANT },
          asUser(OWNER),
        ),
      ),
    ).toBe("UPSTREAM_ERROR");
  });
});

describe("without OPENROUTER_MANAGEMENT_KEY", () => {
  it("builds a broker that refuses with SERVICE_NOT_CONFIGURED instead of crashing", async () => {
    const h = await openLlmDb();
    destroy = h.destroy;
    const secrets = createFakeSecrets();
    const { broker, cfg, openrouter } = createProcessBroker({
      db: h.db,
      transit: null,
      secrets,
      studio: {} as never,
      env: {},
    });
    expect(cfg.managementKey).toBeNull();
    expect(openrouter).toBeNull();
    const s = await setup({ broker, secrets: secrets });
    expect(
      await s.code(
        s.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: TENANT },
          asUser(OWNER),
        ),
      ),
    ).toBe("SERVICE_NOT_CONFIGURED");
    expect(
      await s.r.VetraLlmQueries.studioLlmUsage(
        {},
        { environmentId: ENV },
        asUser(OWNER),
      ),
    ).toBeNull();
  });
});

describe("fix round 1", () => {
  it("writes the export secret even when the broker is not configured", async () => {
    const h = await openLlmDb();
    destroy = h.destroy;
    const secrets = createFakeSecrets();
    const { broker } = createProcessBroker({
      db: h.db,
      transit: null,
      secrets,
      studio: {} as never,
      env: {},
    });
    const s = await setup({ broker, secrets });
    expect(
      await s.code(
        s.r.VetraLlmMutations.provisionStudioLlm(
          {},
          { tenantId: TENANT },
          asUser(OWNER),
        ),
      ),
    ).toBe("SERVICE_NOT_CONFIGURED");
    expect(secrets.secret(TENANT, "VETRA_SESSION_EXPORT_SECRET")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("writes the export secret once under concurrent provisions", async () => {
    const s = await setup();
    const m = s.r.VetraLlmMutations.provisionStudioLlm;
    await Promise.all([
      m({}, { tenantId: TENANT }, asUser(OWNER)),
      m({}, { tenantId: TENANT }, asUser(OWNER)),
    ]);
    const writes = s.secrets.setSecret.mock.calls.filter(
      (c) => c[1] === "VETRA_SESSION_EXPORT_SECRET",
    );
    expect(writes).toHaveLength(1);
  });

  it("redacts a GraphQLError message too, keeping its code", async () => {
    const { GraphQLError } = await import("graphql");
    const s = await setup({
      broker: {
        studioLlmUsage: async () => {
          throw new GraphQLError("bad sk-or-v1-leak vault:v1:abc", {
            extensions: { code: "FORBIDDEN" },
          });
        },
      } as never,
    });
    const err = await s.r.VetraLlmQueries.studioLlmUsage(
      {},
      { environmentId: ENV },
      asUser(OWNER),
    ).catch((e: InstanceType<typeof GraphQLError>) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    const e = err as InstanceType<typeof GraphQLError>;
    expect(e.message).not.toContain("sk-or-v1-leak");
    expect(e.message).not.toContain("vault:");
    expect(e.extensions.code).toBe("FORBIDDEN");
  });

  it("reports a DISABLED or DELETED key as not connected though the secret remains", async () => {
    const s = await setup();
    await s.r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
    const status = s.r.VetraLlmQueries.studioLlmStatus;
    for (const st of ["DISABLED", "DELETED"] as const) {
      await s.store.update(ENV, { status: st });
      expect(s.secrets.secret(TENANT, "OPENROUTER_API_KEY")).toBeDefined();
      expect(
        await status({}, { environmentId: ENV }, asUser(OWNER)),
      ).toStrictEqual({ environmentId: ENV, connected: false });
    }
    await s.store.update(ENV, { status: "ACTIVE" });
    expect(
      await status({}, { environmentId: ENV }, asUser(OWNER)),
    ).toStrictEqual({ environmentId: ENV, connected: true });
  });
});
