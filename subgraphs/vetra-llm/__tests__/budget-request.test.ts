import { afterEach, describe, expect, it } from "vitest";
import {
  ENV,
  OWNER,
  STRANGER,
  asUser,
  resolverHarness,
} from "./resolver-harness.js";

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

describe("requestStudioLlmBudget", () => {
  it("requestStudioLlmBudget records one request per 24h and requires an operator", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    const request = (ctx: object, environmentId = ENV) =>
      s.r.VetraLlmMutations.requestStudioLlmBudget({}, { environmentId }, ctx);
    const rows = () =>
      s.db.selectFrom("studio_llm_budget_requests").selectAll().execute();

    expect(await s.code(request({}))).toBe("UNAUTHENTICATED");
    expect(await s.code(request(asUser(STRANGER)))).toBe("FORBIDDEN");
    expect(await s.code(request(asUser(OWNER), "nope"))).toBe("NOT_FOUND");
    expect(await rows()).toHaveLength(0);

    expect(await request(asUser(OWNER))).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({
      environment_id: ENV,
      requested_by: OWNER,
      requested_at: s.clock.now.toISOString(),
      handled_at: null,
    });
    // Visible at prod's warn level.
    expect(s.logs).toContainEqual({
      level: "error",
      msg: `[vetra-llm] budget request ${ENV} by ${OWNER}`,
    });

    // A second request within 24 h records nothing (and logs nothing).
    s.clock.now = new Date(s.clock.now.getTime() + 23 * 3_600_000);
    expect(await request(asUser(OWNER))).toBe(false);
    // Concurrent repeats too.
    expect(
      await Promise.all([request(asUser(OWNER)), request(asUser(OWNER))]),
    ).toStrictEqual([false, false]);
    expect(await rows()).toHaveLength(1);
    expect(s.logs.filter((l) => l.msg.includes("budget request"))).toHaveLength(
      1,
    );

    // After 24 h an unhandled request no longer blocks a new one.
    s.clock.now = new Date(s.clock.now.getTime() + 2 * 3_600_000);
    expect(await request(asUser(OWNER))).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  it("concurrent first requests record exactly one", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    const request = () =>
      s.r.VetraLlmMutations.requestStudioLlmBudget(
        {},
        { environmentId: ENV },
        asUser(OWNER),
      );
    const res = await Promise.all([request(), request(), request()]);
    expect(res.filter(Boolean)).toHaveLength(1);
  });
});
