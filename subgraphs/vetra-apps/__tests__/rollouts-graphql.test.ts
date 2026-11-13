import { print } from "graphql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER, STRANGER, type Harness } from "./harness.js";
import {
  HOLDER_A,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { createResolvers } from "../resolvers.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, {
    id: "o1",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_A,
  });
});
afterEach(async () => {
  await h.close();
});

const ctx = (address: string, headers: Record<string, string> = {}) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers,
});
const CONSOLE = { origin: "https://vetra.io" };

describe("rollouts over GraphQL", () => {
  it("checks, starts from the console (audited as console), lists, reads and pauses", async () => {
    const r = createResolvers(h.deps);
    const check = await r.Query.checkRollout(
      null,
      { appId, version: "1.4.1", planIds: ["p-pro"] },
      ctx(OWNER),
    );
    expect(check).toMatchObject({
      ok: true,
      problems: [],
      steps: [expect.objectContaining({ instanceId: "o1" })],
    });
    const ro = await r.Mutation.startRollout(
      null,
      {
        input: { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 1 },
      },
      ctx(OWNER, CONSOLE),
    );
    expect(ro).toMatchObject({
      source: "console",
      status: "active",
      steps: [
        expect.objectContaining({ instanceName: "own-o1", status: "pending" }),
      ],
    });
    expect(
      (await r.Query.appRollouts(null, { appId, limit: null }, ctx(OWNER))).map(
        (x) => x.id,
      ),
    ).toEqual([ro.id]);
    expect(
      (await r.Query.rollout(null, { id: ro.id }, ctx(OWNER)))?.version,
    ).toBe("1.4.1");
    expect(await r.Query.rollout(null, { id: "nope" }, ctx(OWNER))).toBeNull();
    expect(
      (
        await r.Mutation.pauseRollout(
          null,
          { rolloutId: ro.id, reason: null },
          ctx(OWNER),
        )
      ).status,
    ).toBe("paused");
    const started = (await listAudit(h.db, appId, { limit: 20 })).find(
      (a) => a.action === "rollout.started",
    )!;
    expect(started.source).toBe("console");
  });

  it("checkRollout previews due dates with the notice asked for, else the plan's", async () => {
    const r = createResolvers(h.deps);
    await h.db
      .updateTable("plans")
      .set({ notice_hours: 48 })
      .where("id", "=", "p-pro")
      .execute();
    const due = (c: { steps: { dueAt: string }[] }) =>
      Date.parse(c.steps[0].dueAt) - h.deps.now().getTime();
    const byPlan = await r.Query.checkRollout(
      null,
      { appId, version: "1.4.1", planIds: ["p-pro"] },
      ctx(OWNER),
    );
    expect(due(byPlan)).toBeGreaterThan(47 * 3_600_000);
    const asked = await r.Query.checkRollout(
      null,
      { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 2 },
      ctx(OWNER),
    );
    expect(due(asked)).toBeLessThan(3 * 3_600_000);
    expect(due(asked)).toBeGreaterThan(1 * 3_600_000);
  });

  it("exposes the new fields in the SDL", async () => {
    const { schema } = await import("../schema.js");
    const sdl = print(schema);
    for (const f of [
      "pinnedVersion: String",
      "withdrawnAt: String",
      "updateWindow: PlanUpdateWindow",
      "policyNote: String",
      "update: HolderUpdate",
      "checkRollout(appId: ID!, version: String!, planIds: [ID!]!, noticeHours: Int): AppRolloutCheck!",
    ])
      expect(sdl).toContain(f);
  });

  it("a holder sees the update and asks for it now; pins and withdrawals go through", async () => {
    const r = createResolvers(h.deps);
    await r.Mutation.startRollout(
      null,
      {
        input: { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 24 },
      },
      ctx(OWNER),
    );
    const [mine] = await r.Query.myInstances(null, {}, ctx(HOLDER_A));
    expect(mine.update).toMatchObject({ version: "1.4.1", canUpdateNow: true });
    expect(
      await r.Mutation.updateInstanceNow(
        null,
        { instanceId: "o1" },
        ctx(HOLDER_A),
      ),
    ).toMatchObject({ canUpdateNow: false });
    expect(
      (
        await r.Mutation.pinInstance(
          null,
          { instanceId: "o1", version: "1.4.0" },
          ctx(OWNER),
        )
      ).pinnedVersion,
    ).toBe("1.4.0");
    expect(
      (
        await r.Mutation.withdrawRelease(
          null,
          { appId, version: "2.0.0", reason: "bad" },
          ctx(OWNER),
        )
      ).withdrawnReason,
    ).toBe("bad");
    await expect(
      r.Mutation.withdrawRelease(
        null,
        { appId, version: "1.5.0", reason: null },
        ctx(STRANGER),
      ),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: "FORBIDDEN" }),
    });
  });
});
