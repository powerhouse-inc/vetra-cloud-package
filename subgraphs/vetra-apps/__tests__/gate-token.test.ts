import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  fakeVault,
  makeHarness,
  OWNER,
  owner,
  stranger,
  type Harness,
} from "./harness.js";
import { gateHarness, plan, syncPlans } from "./gate-fixtures.js";
import { seedLicence } from "./instances-fixtures.js";
import { PLATFORM_MANAGED_KEYS } from "../../vetra-cloud-secrets/services/secrets-service.js";
import {
  GATE_TOKEN_PREFIX,
  hashGateToken,
  isGateTokenShape,
  newGateToken,
  sameGateHash,
} from "../gate/token.js";
import { ensureGateToken, rotateInstanceGateToken } from "../gate/service.js";
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

describe("gate tokens", () => {
  it("are vgt_ + 64 hex, hashed with sha256, compared in constant time", () => {
    const t = newGateToken();
    expect(t.startsWith(GATE_TOKEN_PREFIX)).toBe(true);
    expect(isGateTokenShape(t)).toBe(true);
    expect(newGateToken()).not.toBe(t);
    for (const bad of [
      "",
      "abc",
      `vgt_${"g".repeat(64)}`,
      `vgt_${"a".repeat(63)}`,
      `VGT_${"a".repeat(64)}`,
      `vgt_${"A".repeat(64)}`,
    ])
      expect(isGateTokenShape(bad)).toBe(false);
    expect(hashGateToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGateToken(t)).toBe(hashGateToken(t));
    expect(sameGateHash(hashGateToken(t), hashGateToken(t))).toBe(true);
    expect(sameGateHash(hashGateToken(t), hashGateToken(newGateToken()))).toBe(
      false,
    );
    expect(sameGateHash(hashGateToken(t), "abc")).toBe(false);
    expect(sameGateHash(hashGateToken(t), null)).toBe(false);
  });
});

describe("issuing and rotating gate tokens", () => {
  let g: Harness;
  let appId: string;
  beforeEach(async () => {
    ({ h: g, appId } = await gateHarness());
    await plan(g, appId);
  });
  afterEach(async () => {
    await g.close();
  });
  const shared = async () =>
    (await syncPlans(g, appId)).find((r) => r.kind === "shared")!;
  const audit = () => g.db.selectFrom("app_audit").selectAll().execute();

  it("issues once, audited; the ciphertext decrypts to a token of the stored hash; nothing secret is audited", async () => {
    const row = await shared();
    const a = await ensureGateToken(g.deps, row);
    const b = await ensureGateToken(g.deps, row);
    expect(b.token_id).toBe(a.token_id);
    expect(
      await g.db.selectFrom("instance_gate_tokens").selectAll().execute(),
    ).toHaveLength(1);
    const plain = await fakeVault().decrypt(a.token_ciphertext);
    expect(isGateTokenShape(plain)).toBe(true);
    expect(hashGateToken(plain)).toBe(a.token_hash);
    expect(a.delivered_at).toBeNull();
    const issued = (await audit()).filter(
      (r) => r.action === "gate.token_issued",
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      actor: "vetra",
      source: "system",
      subject: `instance:${row.id}`,
    });
    expect(JSON.parse(issued[0].detail)).toEqual({
      name: row.name,
      planId: "plan-shared",
      tokenId: a.token_id,
    });
    const all = JSON.stringify(await audit());
    expect(all).not.toContain(plain);
    expect(all).not.toContain(a.token_hash);
    expect(all).not.toContain(a.token_ciphertext);
  });

  it("rotates for operators: a new token, the old one kept as previous, audited", async () => {
    const row = await shared();
    const a = await ensureGateToken(g.deps, row);
    const r = await rotateInstanceGateToken(g.deps, owner, row.id);
    expect(r.token_id).not.toBe(a.token_id);
    expect(r.token_hash).not.toBe(a.token_hash);
    // a was never delivered: it is replaced, not kept.
    expect(r.previous_hash).toBeNull();
    await g.db
      .updateTable("instance_gate_tokens")
      .set({ delivered_at: "2026-10-02T00:00:00.000Z" })
      .execute();
    const r2 = await rotateInstanceGateToken(g.deps, owner, row.id);
    expect(r2.previous_hash).toBe(r.token_hash);
    const rotated = (await audit()).filter(
      (x) => x.action === "gate.token_rotated",
    );
    expect(rotated).toHaveLength(2);
    expect(rotated[0]).toMatchObject({
      actor: OWNER,
      subject: `instance:${row.id}`,
    });
    const all = JSON.stringify(await audit());
    for (const x of [a, r, r2]) {
      expect(all).not.toContain(x.token_hash);
      expect(all).not.toContain(await fakeVault().decrypt(x.token_ciphertext));
    }
  });

  it("refuses strangers, own instances, shared ones without a token, and works only with the vault", async () => {
    const row = await shared();
    await expect(
      rotateInstanceGateToken(g.deps, owner, row.id),
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
      message: "The instance has no gate token yet",
    });
    await ensureGateToken(g.deps, row);
    await expect(
      rotateInstanceGateToken(g.deps, stranger, row.id),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      rotateInstanceGateToken(g.deps, owner, "nope"),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });

    await plan(g, appId, {
      id: "plan-own",
      slug: "pro",
      kind: "pro",
      access: "own",
    });
    await seedLicence(g, {
      appId,
      kind: "pro",
      holder: "0x1111111111111111111111111111111111111111",
      licenseId: "l1",
    });
    const own = (await syncPlans(g, appId)).find((r) => r.kind === "own")!;
    await expect(
      rotateInstanceGateToken(g.deps, owner, own.id),
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
      message: "Only shared instances have a gate token",
    });
    await expect(ensureGateToken(g.deps, own)).rejects.toThrow(/shared/);

    g.deps.settingsVault = null;
    await expect(
      rotateInstanceGateToken(g.deps, owner, row.id),
    ).rejects.toMatchObject({ extensions: { code: "SERVICE_NOT_CONFIGURED" } });
    await g.db.deleteFrom("instance_gate_tokens").execute();
    await expect(ensureGateToken(g.deps, row)).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
  });

  it("VETRA_GATE_TOKEN is a platform-managed tenant key", () => {
    expect(PLATFORM_MANAGED_KEYS.has("VETRA_GATE_TOKEN")).toBe(true);
  });
});
