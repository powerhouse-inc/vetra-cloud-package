import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGate } from "../gate/check.js";
import {
  replaceGateToken,
  markGateDelivered,
  startGatePreviousGrace,
} from "../gate/repo.js";
import { ensureGateToken, GATE_PREVIOUS_GRACE_MS } from "../gate/service.js";
import { hashGateToken, newGateToken } from "../gate/token.js";
import { updatePlan } from "../plans/repo.js";
import { gateHarness, plan, syncPlans } from "./gate-fixtures.js";
import { fakeVault, OWNER, type Harness } from "./harness.js";
import { seedLicence } from "./instances-fixtures.js";
import type { InstanceRow } from "../instances/repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
let h: Harness;
let appId: string;
let row: InstanceRow;
let token: string;

beforeEach(async () => {
  ({ h, appId } = await gateHarness());
  await plan(h, appId);
  row = (await syncPlans(h, appId)).find((r) => r.kind === "shared")!;
  token = await fakeVault().decrypt(
    (await ensureGateToken(h.deps, row)).token_ciphertext,
  );
});
afterEach(async () => {
  await h.close();
});

const nowMs = () => h.clock.now.getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const check = (address: string, t = token) => checkGate(h.deps, t, address);

describe("checkGate", () => {
  it("lets the instance's admin in for 60 s", async () => {
    expect(await check(OWNER)).toEqual({
      instanceId: row.id,
      answer: { allowed: true, reason: "admin", until: null, ttlSeconds: 60 },
    });
    expect(
      (await check(OWNER.toUpperCase().replace("0X", "0x")))?.answer.reason,
    ).toBe("admin");
  });

  it("lets a live holder of the plan's kind in, never past the licence's end", async () => {
    const end = iso(nowMs() + 30_500);
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l1",
      endAt: end,
    });
    expect((await check(HOLDER))?.answer).toEqual({
      allowed: true,
      reason: "licence",
      until: end,
      ttlSeconds: 30,
    });
    const later = iso(nowMs() + 86_400_000);
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: OTHER,
      licenseId: "l2",
      endAt: later,
    });
    expect((await check(OTHER))?.answer).toEqual({
      allowed: true,
      reason: "licence",
      until: later,
      ttlSeconds: 60,
    });
  });

  it("an open-ended licence is let in for 60 s", async () => {
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l1",
    });
    expect((await check(HOLDER))?.answer).toEqual({
      allowed: true,
      reason: "licence",
      until: null,
      ttlSeconds: 60,
    });
  });

  it("refuses holders of another kind and strangers for 15 s", async () => {
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    const none = {
      allowed: false,
      reason: "none",
      until: null,
      ttlSeconds: 15,
    };
    expect((await check(HOLDER))?.answer).toEqual(none);
    expect((await check(OTHER))?.answer).toEqual(none);
  });

  it("answers from the licences as they are now (no cache)", async () => {
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l1",
    });
    expect((await check(HOLDER))?.answer.allowed).toBe(true);
    await h.db
      .updateTable("license_lifecycle" as never)
      .set({ status: "EXPIRED" } as never)
      .execute();
    expect((await check(HOLDER))?.answer.reason).toBe("none");
  });

  it("a retired plan keeps serving its holders", async () => {
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l1",
    });
    await updatePlan(h.db, "plan-shared", { status: "retired" }, iso(nowMs()));
    expect((await check(HOLDER))?.answer.reason).toBe("licence");
  });

  it("knows no unknown, malformed, retired or removed instance's token", async () => {
    expect(await check(OWNER, newGateToken())).toBeNull();
    expect(await check(OWNER, "abc")).toBeNull();
    expect(await check(OWNER, token.toUpperCase())).toBeNull();

    // Rotated and delivered: the old token lasts the grace, then is gone.
    await h.db
      .updateTable("instance_gate_tokens")
      .set({ delivered_at: iso(nowMs()) })
      .execute();
    const next = newGateToken();
    await h.db.transaction().execute((trx) =>
      replaceGateToken(
        trx,
        row.id,
        {
          token_hash: hashGateToken(next),
          token_ciphertext: "vault:x",
          token_id: "t2",
        },
        iso(nowMs()),
      ),
    );
    expect((await check(OWNER))?.instanceId).toBe(row.id);
    await markGateDelivered(h.db, row.id, "t2", iso(nowMs()));
    // Delivered, rollout not observed: still accepted.
    h.advance(GATE_PREVIOUS_GRACE_MS + 1000);
    expect((await check(OWNER))?.instanceId).toBe(row.id);
    await startGatePreviousGrace(
      h.db,
      row.id,
      "t2",
      iso(nowMs()),
      GATE_PREVIOUS_GRACE_MS,
    );
    h.advance(GATE_PREVIOUS_GRACE_MS + 1000);
    expect(await check(OWNER)).toBeNull();
    expect((await check(OWNER, next))?.instanceId).toBe(row.id);

    await h.db
      .updateTable("instances")
      .set({ removed_at: iso(nowMs()) })
      .where("id", "=", row.id)
      .execute();
    expect(await check(OWNER, next)).toBeNull();
  });

  it("knows no token of an instance that is not shared", async () => {
    await h.db
      .updateTable("instances")
      .set({ kind: "own" })
      .where("id", "=", row.id)
      .execute();
    expect(await check(OWNER)).toBeNull();
  });

  it("fails (rather than refuses) without the licensing tables", async () => {
    h.deps.licensingDb = null;
    await expect(check(HOLDER)).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
  });
});
