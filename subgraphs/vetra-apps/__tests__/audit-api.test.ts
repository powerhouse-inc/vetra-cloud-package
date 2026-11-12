import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import {
  AUDIT_DETAIL_MAX_BYTES,
  AUDIT_DETAIL_STRING_MAX,
  boundDetail,
  recordAudit,
} from "../audit/repo.js";
import {
  appAuditFor,
  auditCaller,
  callerSource,
  sweepAuditOnce,
} from "../audit/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});
const seed = async (n: number) => {
  for (let i = 0; i < n; i++)
    await auditCaller(h.db, owner, {
      appId,
      at: h.deps.now().toISOString(),
      action: "plan.updated",
      subject: `plan:p${i}`,
    });
};

describe("audit log", () => {
  it("pages newest first with an opaque cursor", async () => {
    await seed(5);
    const p1 = await appAuditFor(h.deps, owner, appId, 2, null);
    expect(p1.entries.map((e) => e.subject)).toEqual(["plan:p4", "plan:p3"]);
    expect(p1.entries[0]).toMatchObject({
      appId,
      actor: owner.address,
      source: "api",
      action: "plan.updated",
      detail: "{}",
    });
    const p2 = await appAuditFor(h.deps, owner, appId, 2, p1.nextBefore);
    expect(p2.entries.map((e) => e.subject)).toEqual(["plan:p2", "plan:p1"]);
    const p3 = await appAuditFor(h.deps, owner, appId, 2, p2.nextBefore);
    expect(p3).toMatchObject({
      entries: [expect.objectContaining({ subject: "plan:p0" })],
      nextBefore: null,
    });
  });

  it("pages rows that share one at, each exactly once", async () => {
    const at = h.deps.now().toISOString();
    for (let i = 0; i < 4; i++)
      await recordAudit(h.db, {
        appId,
        at,
        actor: "vetra",
        source: "system",
        action: "instance.status",
        subject: `instance:i${i}`,
      });
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const p = await appAuditFor(h.deps, owner, appId, 1, before);
      seen.push(...p.entries.map((e) => e.subject));
      before = p.nextBefore;
      if (!before) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("clamps the page size and refuses a malformed cursor", async () => {
    await seed(3);
    expect(
      (await appAuditFor(h.deps, owner, appId, 0, null)).entries,
    ).toHaveLength(1);
    expect(
      (await appAuditFor(h.deps, owner, appId, 10_000, null)).entries,
    ).toHaveLength(3);
    expect(
      (await appAuditFor(h.deps, owner, appId, null, null)).entries,
    ).toHaveLength(3);
    await expect(
      appAuditFor(h.deps, owner, appId, 10, "bm9wZQ"),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
  });

  it("is for those who may view the App", async () => {
    await expect(
      appAuditFor(h.deps, stranger, appId, 10, null),
    ).rejects.toMatchObject(code("FORBIDDEN"));
  });

  it("records the caller's source, api when none", async () => {
    await auditCaller(
      h.db,
      { ...owner, source: "console" },
      {
        appId,
        at: h.deps.now().toISOString(),
        action: "plan.retired",
        subject: "plan:x",
      },
    );
    expect(
      (await appAuditFor(h.deps, owner, appId, 1, null)).entries[0].source,
    ).toBe("console");
  });

  it("tells the console by the request's Origin", () => {
    const at = (origin?: string) =>
      origin ? { headers: { origin } } : { headers: {} };
    expect(callerSource(at("https://vetra.io"), "https://vetra.io")).toBe(
      "console",
    );
    expect(callerSource(at("https://vetra.io"), "https://vetra.io/")).toBe(
      "console",
    );
    expect(callerSource(at("https://evil.example"), "https://vetra.io")).toBe(
      "api",
    );
    expect(callerSource(at("not a url"), "https://vetra.io")).toBe("api");
    expect(callerSource(at(), "https://vetra.io")).toBe("api");
  });

  it("keeps one year", async () => {
    await recordAudit(h.db, {
      appId,
      at: "2025-10-01T00:00:00.000Z",
      actor: "vetra",
      source: "system",
      action: "instance.status",
      subject: "instance:x",
    });
    await seed(1);
    expect(await sweepAuditOnce(h.deps)).toBe(1);
    expect(
      (await appAuditFor(h.deps, owner, appId, 10, null)).entries,
    ).toHaveLength(1);
  });

  const seedOld = async (n: number) => {
    for (let i = 0; i < n; i++)
      await recordAudit(h.db, {
        appId,
        at: `2025-10-01T00:00:0${i}.000Z`,
        actor: "vetra",
        source: "system",
        action: "instance.status",
        subject: `instance:${i}`,
      });
  };

  it("sweeps batch after batch while they are full", async () => {
    await seedOld(3);
    expect(await sweepAuditOnce(h.deps, { batch: 1, maxBatches: 10 })).toBe(3);
  });

  it("stops after maxBatches in one pass", async () => {
    await seedOld(2);
    expect(await sweepAuditOnce(h.deps, { batch: 1, maxBatches: 1 })).toBe(1);
    expect(await sweepAuditOnce(h.deps, { batch: 1, maxBatches: 1 })).toBe(1);
    expect(await sweepAuditOnce(h.deps, { batch: 1, maxBatches: 1 })).toBe(0);
  });

  it("cuts long strings at every depth", () => {
    const long = "x".repeat(AUDIT_DETAIL_STRING_MAX + 10);
    const cut = `${"x".repeat(AUDIT_DETAIL_STRING_MAX)}…`;
    expect(
      JSON.parse(
        boundDetail({ a: long, b: { c: long, d: [long, 1] }, e: null }),
      ),
    ).toEqual({ a: cut, b: { c: cut, d: [cut, 1] }, e: null });
  });

  it("caps the serialised detail", () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "y".repeat(400)]),
    );
    expect(boundDetail(many)).toBe('{"truncated":true}');
    expect(
      Buffer.byteLength(boundDetail({ a: "é".repeat(400) })),
    ).toBeLessThanOrEqual(AUDIT_DETAIL_MAX_BYTES);
  });
});
