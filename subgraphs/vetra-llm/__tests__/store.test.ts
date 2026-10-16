import { afterEach, describe, expect, it } from "vitest";
import type { StudioLlmKeys } from "../db/schema.js";
import { createLlmKeyStore } from "../store.js";
import { openLlmDb } from "./llm-db.js";

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

const row = (over: Partial<StudioLlmKeys> = {}): StudioLlmKeys => ({
  environment_id: "env-1",
  source: "VETRA",
  key_hash: "hash-1",
  key_ciphertext: "vault:v1:abc",
  limit_usd: 20.5,
  limit_reset: "monthly",
  model: "anthropic/claude-sonnet-4.6",
  owner_did: "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "ACTIVE",
  created_at: "2026-10-15T10:00:00.000Z",
  updated_at: "2026-10-15T10:00:00.000Z",
  ...over,
});

describe("LlmKeyStore", () => {
  it("round-trips a row and reads money back as a number, not a numeric string", async () => {
    const h = await openLlmDb();
    destroy = h.destroy;
    const store = createLlmKeyStore(h.db);
    await store.upsert(row());
    const got = await store.get("env-1");
    expect(got).toStrictEqual(row());
    expect(typeof got!.limit_usd).toBe("number");
  });

  it("upserts on environment_id and keeps created_at", async () => {
    const h = await openLlmDb();
    destroy = h.destroy;
    const store = createLlmKeyStore(h.db);
    await store.upsert(row());
    await store.upsert(
      row({
        key_hash: "hash-2",
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2026-10-16T00:00:00.000Z",
      }),
    );
    const got = await store.get("env-1");
    expect(got?.key_hash).toBe("hash-2");
    expect(got?.created_at).toBe("2026-10-15T10:00:00.000Z");
    expect(got?.updated_at).toBe("2026-10-16T00:00:00.000Z");
  });

  it("updates fields and lists only rows that still hold a key", async () => {
    const h = await openLlmDb();
    destroy = h.destroy;
    const store = createLlmKeyStore(h.db);
    await store.upsert(row({ environment_id: "a" }));
    await store.upsert(row({ environment_id: "b", status: "DISABLED" }));
    await store.upsert(
      row({ environment_id: "c", status: "DELETED", key_ciphertext: null }),
    );
    await store.upsert(row({ environment_id: "d", key_hash: null }));
    await store.update("a", {
      limit_usd: 7,
      updated_at: "2026-10-16T00:00:00.000Z",
    });
    expect((await store.get("a"))?.limit_usd).toBe(7);
    expect(
      (await store.listHeld()).map((r) => r.environment_id).sort(),
    ).toStrictEqual(["a", "b"]);
    expect(await store.get("nope")).toBeNull();
  });
});
