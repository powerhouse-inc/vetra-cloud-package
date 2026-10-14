import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "./migrations.js";
import type { DB } from "./schema.js";
import { VetraCloudEnvironmentProcessor } from "./processor.js";
import { getTenantId } from "./gitops.js";

let db: Kysely<DB>;
beforeEach(async () => {
  db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
});
afterEach(async () => {
  await db.destroy();
});

const ENV_TYPE = "powerhouse/vetra-cloud-environment";

const purgeTenant = vi.fn(async () => ({ envVars: 1, secrets: 1 }));
function processor() {
  const dispatch = { execute: vi.fn() };
  const documentView = { get: vi.fn() };
  return new VetraCloudEnvironmentProcessor(db, dispatch as never, documentView as never, { purgeTenant } as never);
}

/** One environment operation whose resulting state is `global`. */
function envOp(documentId: string, global: Record<string, unknown>) {
  return {
    operation: { index: 0, action: { type: "SET_LABEL", input: {}, context: {} } },
    context: { documentType: ENV_TYPE, documentId, resultingState: JSON.stringify({ global }) },
  } as never;
}

const state = (owner: string, label: string) => ({
  owner,
  label,
  genericSubdomain: "shop",
  status: "READY",
  packages: [],
  services: [],
});

describe("processor: a tenantId already deployed by another environment is refused", () => {
  // Same subdomain and same first 8 id characters: the same tenantId.
  const VICTIM = "abcdef12-0000-victim";
  const ATTACKER = "abcdef12-9999-attacker";

  it("does not project the colliding environment, and logs it", async () => {
    expect(getTenantId("shop", VICTIM)).toBe(getTenantId("shop", ATTACKER));
    const p = processor();
    await p.onOperations([envOp(VICTIM, state("0xvictim", "Victim"))]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await p.onOperations([envOp(ATTACKER, state("0xattacker", "Attacker"))]);
    } finally {
      error.mockRestore();
    }
    const rows = await db.selectFrom("environments").select(["id", "owner", "tenantId"]).execute();
    expect(rows).toStrictEqual([{ id: VICTIM, owner: "0xvictim", tenantId: "shop-abcdef12" }]);
  });

  it("keeps updating the environment that owns the tenantId", async () => {
    const p = processor();
    await p.onOperations([envOp(VICTIM, state("0xvictim", "Victim"))]);
    await p.onOperations([envOp(VICTIM, state("0xvictim", "Renamed"))]);
    const row = await db.selectFrom("environments").select(["name"]).executeTakeFirstOrThrow();
    expect(row.name).toBe("Renamed");
  });

  it("does not move an existing environment onto another's tenantId", async () => {
    const p = processor();
    await p.onOperations([envOp(VICTIM, state("0xvictim", "Victim"))]);
    await p.onOperations([envOp(ATTACKER, { ...state("0xattacker", "A"), genericSubdomain: "other" })]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await p.onOperations([envOp(ATTACKER, state("0xattacker", "A"))]);
    } finally {
      error.mockRestore();
    }
    const attacker = await db
      .selectFrom("environments")
      .select(["tenantId"])
      .where("id", "=", ATTACKER)
      .executeTakeFirstOrThrow();
    expect(attacker.tenantId).toBe("other-abcdef12");
  });
});

describe("processor: tenantId collisions only refuse a newcomer", () => {
  it("legacy rows already sharing a tenantId both keep updating (no freeze)", async () => {
    await db.insertInto("environments").values([
      { id: "abcdef12-0000-a", tenantId: "shop-abcdef12", subdomain: "shop", owner: "0xa" },
      { id: "abcdef12-0000-b", tenantId: "shop-abcdef12", subdomain: "shop", owner: "0xb" },
    ] as never).execute();
    const p = processor();
    await p.onOperations([envOp("abcdef12-0000-a", state("0xa", "A2"))]);
    await p.onOperations([envOp("abcdef12-0000-b", state("0xb", "B2"))]);
    const rows = await db.selectFrom("environments").select(["id", "name"]).orderBy("id").execute();
    expect(rows).toStrictEqual([
      { id: "abcdef12-0000-a", name: "A2" },
      { id: "abcdef12-0000-b", name: "B2" },
    ]);
  });
});

describe("processor: a drive DELETE_NODE never destroys tenant configuration", () => {
  const deleteNode = (id: string, error?: string) =>
    ({
      operation: { index: 0, action: { type: "DELETE_NODE", input: { id }, context: {} }, ...(error ? { error } : {}) },
      context: { documentType: "powerhouse/document-drive", documentId: "someone-elses-drive" },
    }) as never;

  beforeEach(() => purgeTenant.mockClear());

  it("a foreign drive's DELETE_NODE of a live env purges no env vars or secrets", async () => {
    await db.insertInto("environments").values({ id: "victim", tenantId: "t-victim", owner: "0xv" } as never).execute();
    await processor().onOperations([deleteNode("victim")]);
    expect(purgeTenant).not.toHaveBeenCalled();
  });

  it("a failed DELETE_NODE (operation error) changes nothing", async () => {
    await db.insertInto("environments").values({ id: "victim", tenantId: "t-victim", owner: "0xv" } as never).execute();
    await processor().onOperations([deleteNode("victim", "node not found")]);
    expect(await db.selectFrom("environments").select("id").execute()).toStrictEqual([{ id: "victim" }]);
    expect(purgeTenant).not.toHaveBeenCalled();
  });
});
