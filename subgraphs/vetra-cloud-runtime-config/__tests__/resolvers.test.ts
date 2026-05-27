import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "../bundled-defaults.js";
import { InvalidRuntimeConfigError } from "../errors.js";
import { createResolvers } from "../resolvers.js";
import { InMemoryEnvVarsStore } from "../store.js";

const authedCtx = { user: { address: "0x1234" } };

function setup() {
  const store = new InMemoryEnvVarsStore();
  const resolvers = createResolvers({ store });
  return { store, resolvers };
}

describe("Query runtimeConfig", () => {
  it("returns defaults + empty overrides when nothing stored", async () => {
    const { resolvers } = setup();
    const payload = await resolvers.Query.runtimeConfig(
      null,
      { tenantId: "t1" },
      authedCtx,
    );
    expect(payload.overrides).toEqual({});
    expect(payload.effective.connect).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
    expect(payload.updatedAt).toBeNull();
    expect(payload.schemaVersion).toBe("2");
  });

  it("merges stored overrides on top of defaults", async () => {
    const { store, resolvers } = setup();
    await store.setRuntimeConfigOverrides(
      "t1",
      JSON.stringify({ connect: { branding: { appName: "Acme" } } }),
    );
    const payload = await resolvers.Query.runtimeConfig(
      null,
      { tenantId: "t1" },
      authedCtx,
    );
    expect(payload.effective.connect.branding?.appName).toBe("Acme");
    expect(payload.overrides).toEqual({
      connect: { branding: { appName: "Acme" } },
    });
    expect(payload.updatedAt).not.toBeNull();
  });

  it("isolates tenants on read", async () => {
    const { store, resolvers } = setup();
    await store.setRuntimeConfigOverrides(
      "t1",
      JSON.stringify({ connect: { branding: { appName: "Acme" } } }),
    );
    const payload = await resolvers.Query.runtimeConfig(
      null,
      { tenantId: "t2" },
      authedCtx,
    );
    expect(payload.overrides).toEqual({});
  });

  it("throws Unauthenticated when ctx.user is missing", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Query.runtimeConfig(null, { tenantId: "t1" }, {}),
    ).rejects.toThrow(/Unauthenticated/);
  });
});

describe("Mutation setRuntimeConfig", () => {
  it("rejects invalid JSON with InvalidRuntimeConfigError", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Mutation.setRuntimeConfig(
        null,
        { tenantId: "t1", json: { connect: { app: { logLevel: 123 } } } },
        authedCtx,
      ),
    ).rejects.toThrowError(InvalidRuntimeConfigError);
  });

  it("persists valid JSON and returns the new effective", async () => {
    const { store, resolvers } = setup();
    const payload = await resolvers.Mutation.setRuntimeConfig(
      null,
      {
        tenantId: "t1",
        json: { connect: { branding: { appName: "Acme" } } },
      },
      authedCtx,
    );
    expect(payload.effective.connect.branding?.appName).toBe("Acme");
    const row = await store.getRuntimeConfigOverrides("t1");
    expect(row).not.toBeNull();
    expect(row!.value).toContain("Acme");
  });

  it("empty object deletes the row (revert to defaults)", async () => {
    const { store, resolvers } = setup();
    await store.setRuntimeConfigOverrides(
      "t1",
      JSON.stringify({ connect: { branding: { appName: "Acme" } } }),
    );
    const payload = await resolvers.Mutation.setRuntimeConfig(
      null,
      { tenantId: "t1", json: {} },
      authedCtx,
    );
    expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();
    expect(payload.effective.connect).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
    expect(payload.updatedAt).toBeNull();
  });

  it("throws Unauthenticated when ctx.user is missing", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Mutation.setRuntimeConfig(
        null,
        { tenantId: "t1", json: {} },
        {},
      ),
    ).rejects.toThrow(/Unauthenticated/);
  });
});
