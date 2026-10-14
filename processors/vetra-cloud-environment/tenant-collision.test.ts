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

function processor() {
  const dispatch = { execute: vi.fn() };
  const documentView = { get: vi.fn() };
  return new VetraCloudEnvironmentProcessor(db, dispatch as never, documentView as never);
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
