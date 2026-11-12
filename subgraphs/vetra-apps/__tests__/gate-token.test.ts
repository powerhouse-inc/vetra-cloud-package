import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { makeHarness, type Harness } from "./harness.js";
import {
  findByTokenHash,
  getGateToken,
  insertGateToken,
  lockGateToken,
  markGateDelivered,
  replaceGateToken,
} from "../gate/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const T = (n: string) => ({
  token_hash: n.repeat(64),
  token_ciphertext: `vault:${n}`,
  token_id: `tid-${n}`,
});
const NOW = "2026-11-12T10:00:00.000Z";
const first = () =>
  insertGateToken(h.db, {
    instance_id: "i1",
    app_id: "a1",
    ...T("a"),
    previous_hash: null,
    previous_until: null,
    delivered_at: NOW,
    created_at: NOW,
    rotated_at: NOW,
  });
const rotate = (n: string) =>
  h.db.transaction().execute(async (trx) => {
    await lockGateToken(trx, "i1");
    return replaceGateToken(trx, "i1", T(n), NOW);
  });

describe("gate token rows", () => {
  it("licensing has an index by (app_id, user_address) for the gate's lookup", async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'app_license_grants_app_user_idx'
    `.execute(h.db);
    expect(rows[0]?.indexdef).toMatch(/\(app_id, user_address\)/);
  });

  it("inserts once: a second insert for the instance returns null", async () => {
    expect((await first())?.token_id).toBe("tid-a");
    expect(await first()).toBeNull();
  });

  it("finds a row by its current hash, and by the previous one only while it is accepted", async () => {
    await first();
    expect(
      (await findByTokenHash(h.db, "a".repeat(64), NOW))?.instance_id,
    ).toBe("i1");
    await rotate("b");
    // Not delivered yet: both work.
    expect(
      (await findByTokenHash(h.db, "a".repeat(64), NOW))?.instance_id,
    ).toBe("i1");
    expect(
      (await findByTokenHash(h.db, "b".repeat(64), NOW))?.instance_id,
    ).toBe("i1");
    expect(await markGateDelivered(h.db, "i1", "tid-b", NOW, 15 * 60_000)).toBe(
      true,
    );
    // Once only.
    expect(await markGateDelivered(h.db, "i1", "tid-b", NOW, 15 * 60_000)).toBe(
      false,
    );
    expect(
      await findByTokenHash(h.db, "a".repeat(64), "2026-11-12T10:14:00.000Z"),
    ).not.toBeNull();
    expect(
      await findByTokenHash(h.db, "a".repeat(64), "2026-11-12T10:16:00.000Z"),
    ).toBeNull();
    expect(
      await findByTokenHash(h.db, "b".repeat(64), "2026-11-12T10:16:00.000Z"),
    ).not.toBeNull();
  });

  it("does not mark a token delivered when another one replaced it meanwhile", async () => {
    await first();
    await rotate("b");
    await rotate("c");
    expect(await markGateDelivered(h.db, "i1", "tid-b", NOW, 60_000)).toBe(
      false,
    );
    expect((await getGateToken(h.db, "i1"))!.delivered_at).toBeNull();
  });

  it("a second rotation before delivery keeps the delivered token as the previous one", async () => {
    await first();
    for (const n of ["b", "c"]) await rotate(n);
    const row = (await getGateToken(h.db, "i1"))!;
    expect(row.previous_hash).toBe("a".repeat(64));
    expect(row.token_hash).toBe("c".repeat(64));
    expect(await findByTokenHash(h.db, "b".repeat(64), NOW)).toBeNull();
    expect(await findByTokenHash(h.db, "a".repeat(64), NOW)).not.toBeNull();
  });
});
