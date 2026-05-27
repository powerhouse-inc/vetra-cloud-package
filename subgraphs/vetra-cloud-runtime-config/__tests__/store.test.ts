import { describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  InMemoryEnvVarsStore,
  KyselyEnvVarsStore,
  type EnvVarsTable,
} from "../store.js";

describe("InMemoryEnvVarsStore", () => {
  it("returns null when nothing is stored", async () => {
    const s = new InMemoryEnvVarsStore();
    expect(await s.getRuntimeConfigOverrides("t1")).toBeNull();
  });

  it("round-trips a value with updatedAt", async () => {
    const s = new InMemoryEnvVarsStore();
    const { updatedAt } = await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    expect(updatedAt).toBeInstanceOf(Date);
    const row = await s.getRuntimeConfigOverrides("t1");
    expect(row).not.toBeNull();
    expect(row!.value).toBe('{"a":1}');
  });

  it("set(null) deletes the row", async () => {
    const s = new InMemoryEnvVarsStore();
    await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    const res = await s.setRuntimeConfigOverrides("t1", null);
    expect(res.updatedAt).toBeNull();
    expect(await s.getRuntimeConfigOverrides("t1")).toBeNull();
  });

  it("isolates tenants", async () => {
    const s = new InMemoryEnvVarsStore();
    await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    expect(await s.getRuntimeConfigOverrides("t2")).toBeNull();
  });
});

describe("KyselyEnvVarsStore (pglite-backed)", () => {
  async function setupDb() {
    const pg = new PGlite();
    const db = new Kysely<EnvVarsTable>({
      dialect: new PGliteDialect(pg),
    });
    const store = new KyselyEnvVarsStore(db);
    await store.ensureSchema();
    return { db, store };
  }

  it("returns null when nothing is stored", async () => {
    const { db, store } = await setupDb();
    try {
      expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("round-trips a value with updatedAt and replaces on second write", async () => {
    const { db, store } = await setupDb();
    try {
      const first = await store.setRuntimeConfigOverrides("t1", '{"a":1}');
      expect(first.updatedAt).toBeInstanceOf(Date);

      const row = await store.getRuntimeConfigOverrides("t1");
      expect(row?.value).toBe('{"a":1}');

      const second = await store.setRuntimeConfigOverrides("t1", '{"a":2}');
      expect(second.updatedAt).toBeInstanceOf(Date);

      const after = await store.getRuntimeConfigOverrides("t1");
      expect(after?.value).toBe('{"a":2}');
    } finally {
      await db.destroy();
    }
  });

  it("set(null) deletes the row", async () => {
    const { db, store } = await setupDb();
    try {
      await store.setRuntimeConfigOverrides("t1", '{"a":1}');
      const del = await store.setRuntimeConfigOverrides("t1", null);
      expect(del.updatedAt).toBeNull();
      expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("isolates tenants", async () => {
    const { db, store } = await setupDb();
    try {
      await store.setRuntimeConfigOverrides("t1", '{"a":1}');
      expect(await store.getRuntimeConfigOverrides("t2")).toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
