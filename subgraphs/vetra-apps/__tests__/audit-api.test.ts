import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import { recordAudit } from "../audit/repo.js";
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
});
