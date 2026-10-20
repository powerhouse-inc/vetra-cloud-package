import { describe, expect, it, vi } from "vitest";
import {
  claimedStudiosFrom,
  migrateStudiosToOpenRouter,
  type MigrationDeps,
} from "../migrate.js";
import { createFakeSecrets } from "./fakes.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddd";

function deps(over: Partial<MigrationDeps> = {}) {
  const secrets = createFakeSecrets();
  const d: MigrationDeps = {
    listClaimedStudios: async () => [
      { id: "budgeted", tenantId: "t-a", owner: A },
      { id: "no-budget", tenantId: "t-b", owner: B },
      { id: "lapsed", tenantId: "t-c", owner: C },
      { id: "broken", tenantId: "t-d", owner: D },
    ],
    budgetForDid: vi.fn(async (did: string) =>
      did.endsWith(A) || did.endsWith(D)
        ? { allowed: true, budgetUsd: 20 }
        : did.endsWith(B)
          ? { allowed: true, budgetUsd: 0 }
          : { allowed: false, budgetUsd: 0 },
    ),
    budgetOverride: async () => null,
    provision: vi.fn(async (i: { environmentId: string }) => {
      if (i.environmentId === "broken")
        throw new Error("openrouter down sk-or-v1-leak");
      return { connected: true, llmBudgetUsd: 20 };
    }),
    secrets,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { d, secrets };
}

describe("migrateStudiosToOpenRouter", () => {
  it("dry run: classifies every Studio and provisions nothing", async () => {
    const { d } = deps();
    expect(
      await migrateStudiosToOpenRouter(d, {
        dryRun: true,
        removeAnthropicSecrets: true,
      }),
    ).toStrictEqual({
      dryRun: true,
      scanned: 4,
      provisioned: ["budgeted", "broken"],
      noBudget: ["no-budget"],
      noLicence: ["lapsed"],
      failed: [],
      anthropicSecretsRemoved: 0,
    });
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("honours a per-Studio budget override, but not over a lapsed licence", async () => {
    const { d } = deps({
      budgetOverride: async (env: string) =>
        env === "no-budget" || env === "lapsed" ? 30 : null,
    });
    const r = await migrateStudiosToOpenRouter(d, {
      dryRun: true,
      removeAnthropicSecrets: false,
    });
    expect(r).toMatchObject({
      provisioned: ["budgeted", "no-budget", "broken"],
      noBudget: [],
      noLicence: ["lapsed"],
    });
  });

  it("provisions budgeted Studios with the owner's DID, isolates failures and never logs keys", async () => {
    const { d } = deps();
    const r = await migrateStudiosToOpenRouter(d, {
      dryRun: false,
      removeAnthropicSecrets: false,
    });
    expect(r).toMatchObject({
      provisioned: ["budgeted"],
      noBudget: ["no-budget"],
      noLicence: ["lapsed"],
      failed: ["broken"],
    });
    expect(d.provision).toHaveBeenCalledWith({
      environmentId: "budgeted",
      tenantId: "t-a",
      ownerDid: `did:pkh:eip155:1:${A}`,
    });
    const logged = vi.mocked(d.logger.warn).mock.calls.flat().join("\n");
    expect(logged).not.toMatch(/sk-or-/);
  });

  it("removes the three Anthropic secrets from every scanned Studio when asked (cut-over step 4)", async () => {
    const { d, secrets } = deps();
    for (const t of ["t-a", "t-b"]) {
      for (const n of [
        "ANTHROPIC_API_KEY",
        "VETRA_ANTHROPIC_API_KEY",
        "VETRA_CLI_ANTHROPIC_API_KEY",
      ]) {
        await secrets.setSecret(t, n, "sk-ant-x");
      }
    }
    const r = await migrateStudiosToOpenRouter(d, {
      dryRun: false,
      removeAnthropicSecrets: true,
    });
    expect(r.anthropicSecretsRemoved).toBe(6);
    expect(secrets.secret("t-a", "ANTHROPIC_API_KEY")).toBeUndefined();
  });
});

describe("claimedStudiosFrom", () => {
  it("keeps owned, live Studio rows with a tenant", () => {
    const studio = JSON.stringify([{ name: "vetra", version: "1" }]);
    expect(
      claimedStudiosFrom([
        {
          id: "ok",
          tenantId: "t1",
          owner: "0xAA",
          status: "READY",
          packages: studio,
        },
        {
          id: "unclaimed",
          tenantId: "t2",
          owner: null,
          status: "READY",
          packages: studio,
        },
        {
          id: "released",
          tenantId: "t3",
          owner: "0xaa",
          status: "DESTROYED",
          packages: studio,
        },
        {
          id: "not-studio",
          tenantId: "t4",
          owner: "0xaa",
          status: "READY",
          packages: JSON.stringify([{ name: "x" }]),
        },
        {
          id: "no-tenant",
          tenantId: null,
          owner: "0xaa",
          status: "READY",
          packages: studio,
        },
      ]),
    ).toStrictEqual([{ id: "ok", tenantId: "t1", owner: "0xaa" }]);
  });
});
