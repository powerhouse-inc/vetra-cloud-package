import { describe, it, expect, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createEnvironmentRows } from "../rows.js";

const MIXED = "0xAbCdEf0000000000000000000000000000000001";
const row = (o: Partial<Record<string, string>> = {}) => ({
  app_id: "app-1",
  user_address: MIXED,
  environment_id: "env-1",
  license_id: "lic-1",
  template_hash: "unapplied",
  created_at: "t0",
  updated_at: "t0",
  ...o,
});

describe("createEnvironmentRows (real PGlite)", () => {
  let db: Kysely<VetraLicensingDB> | undefined;
  const open = async (def = 7) => {
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await up(db as Kysely<any>);
    return createEnvironmentRows(db, { defaultMaxEnvironments: def });
  };
  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("claimRow stores the address lowercased and keeps the first claimant", async () => {
    const r = await open();
    const a = await r.claimRow(row());
    expect(a.user_address).toBe(MIXED.toLowerCase());
    const b = await r.claimRow(row({ environment_id: "env-2" }));
    expect(b.environment_id).toBe("env-1");
  });

  it("findRow matches a mixed-case caller to the lowercased row", async () => {
    const r = await open();
    await r.claimRow(row());
    expect((await r.findRow("app-1", MIXED))?.environment_id).toBe("env-1");
    expect(await r.findRow("app-2", MIXED)).toBeNull();
  });

  it("upsertRow lowercases, so a mixed-case caller updates rather than duplicates", async () => {
    const r = await open();
    await r.claimRow(row());
    const u = await r.upsertRow(
      row({ environment_id: "env-9", license_id: "lic-2", template_hash: "h", updated_at: "t1" }),
    );
    expect(u).toMatchObject({
      environment_id: "env-1",
      license_id: "lic-2",
      template_hash: "h",
      updated_at: "t1",
    });
    expect(await r.countForApp("app-1")).toBe(1);
  });

  it("countForApp counts one app only", async () => {
    const r = await open();
    await r.claimRow(row());
    await r.claimRow(row({ user_address: "0xb", environment_id: "e2" }));
    await r.claimRow(row({ app_id: "app-2", environment_id: "e3" }));
    expect(await r.countForApp("app-1")).toBe(2);
  });

  it("maxForApp uses the configured default, and a per-app override when present", async () => {
    const r = await open(7);
    expect(await r.maxForApp("app-1")).toBe(7);
    await db!
      .insertInto("app_environment_limits")
      .values({ app_id: "app-1", max_environments: 3 } as never)
      .execute();
    expect(await r.maxForApp("app-1")).toBe(3);
    expect(await r.maxForApp("app-2")).toBe(7);
  });
});
