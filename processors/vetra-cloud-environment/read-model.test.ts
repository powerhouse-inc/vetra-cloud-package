import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "./migrations.js";
import { appLinkColumns, backupScheduleColumn, hostColumns, orgColumns } from "./processor.js";
import type { DB } from "./schema.js";

describe("environments read model — App link columns", () => {
  it("adds appId / appRole / prNumber (idempotently)", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>); // second run must not throw
    await db
      .insertInto("environments")
      .values({
        id: "e1",
        appId: "app-1",
        appRole: "PREVIEW",
        prNumber: 42,
      } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["appId", "appRole", "prNumber"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ appId: "app-1", appRole: "PREVIEW", prNumber: 42 });
    await db.destroy();
  });

  it("maps state.app to the row columns", () => {
    expect(
      appLinkColumns({
        app: {
          appId: "app-1",
          role: "PREVIEW",
          prNumber: 7,
          gitRef: "refs/pull/7/merge",
          imageProject: "app-x",
        },
      }),
    ).toStrictEqual({ appId: "app-1", appRole: "PREVIEW", prNumber: 7 });
  });

  it("maps a missing or null link to NULLs (standalone env)", () => {
    const nulls = { appId: null, appRole: null, prNumber: null };
    expect(appLinkColumns({ app: null })).toStrictEqual(nulls);
    expect(appLinkColumns({})).toStrictEqual(nulls);
  });
});

describe("environments read model — organisation columns", () => {
  it("adds ownerOrgId / orgOperators (idempotently)", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    await db
      .insertInto("environments")
      .values({ id: "e1", ownerOrgId: "org-1", orgOperators: '["0xabc"]' } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["ownerOrgId", "orgOperators"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ ownerOrgId: "org-1", orgOperators: '["0xabc"]' });
    await db.destroy();
  });

  it("maps the state to the columns; personal and legacy states map to NULL and []", () => {
    expect(orgColumns({ ownerOrgId: "org-1", orgOperators: ["0xabc"] })).toStrictEqual({
      ownerOrgId: "org-1",
      orgOperators: '["0xabc"]',
    });
    expect(orgColumns({ ownerOrgId: null, orgOperators: [] })).toStrictEqual({ ownerOrgId: null, orgOperators: "[]" });
    expect(orgColumns({})).toStrictEqual({ ownerOrgId: null, orgOperators: "[]" });
  });
});

describe("environments read model — backupSchedule column", () => {
  it("adds backupSchedule (idempotently) and round-trips it", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    await db
      .insertInto("environments")
      .values({ id: "e1", backupSchedule: '{"enabled":false,"cadence":"DAILY","retention":7}' } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["backupSchedule"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row.backupSchedule).toBe('{"enabled":false,"cadence":"DAILY","retention":7}');
    await db.destroy();
  });

  it("serializes state.backupSchedule, NULL when unset", () => {
    expect(
      backupScheduleColumn({ backupSchedule: { enabled: true, cadence: "HOURLY", retention: 3 } }),
    ).toStrictEqual({ backupSchedule: '{"enabled":true,"cadence":"HOURLY","retention":3}' });
    expect(backupScheduleColumn({ backupSchedule: null })).toStrictEqual({ backupSchedule: null });
    expect(backupScheduleColumn({})).toStrictEqual({ backupSchedule: null });
  });
});

describe("environments read model — host lookup columns", () => {
  it("adds genericBaseDomain / apexService (idempotently)", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    await db
      .insertInto("environments")
      .values({ id: "e1", genericBaseDomain: "vetra.io", apexService: "FUSION" } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["genericBaseDomain", "apexService"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ genericBaseDomain: "vetra.io", apexService: "FUSION" });
    await db.destroy();
  });

  it("maps state.genericBaseDomain and state.apexService", () => {
    expect(
      hostColumns({ genericBaseDomain: "vetra.io", apexService: "CONNECT" }),
    ).toStrictEqual({ genericBaseDomain: "vetra.io", apexService: "CONNECT" });
    expect(hostColumns({})).toStrictEqual({
      genericBaseDomain: null,
      apexService: null,
    });
  });
});
