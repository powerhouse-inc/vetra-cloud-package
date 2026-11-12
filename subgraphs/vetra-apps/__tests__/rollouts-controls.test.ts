import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import {
  becomeReady,
  code,
  failUpdate,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import {
  cancelRollout,
  pauseRollout,
  resumeRollout,
  retryRolloutStep,
  skipRolloutStep,
} from "../rollouts/controls.js";

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
    createdAt: "2026-10-01T00:00:01.000Z",
  });
  await readyInstance(h, appId, {
    id: "o2",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_B,
    createdAt: "2026-10-01T00:00:02.000Z",
  });
});
afterEach(async () => {
  await h.close();
});

const advance = async () =>
  advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const start = () =>
  startRollout(h.deps, owner, {
    appId,
    version: "1.4.1",
    planIds: ["p-pro"],
    noticeHours: 0,
  });
const step = async (rolloutId: string, instanceId: string) =>
  (await stepsOf(h.db, rolloutId)).find((s) => s.instance_id === instanceId)!;

describe("rollout controls (spec 7 step 5)", () => {
  it("pause holds the next step; resume continues", async () => {
    const r = await start();
    await advance();
    await pauseRollout(h.deps, owner, r.id, "waiting for support");
    await becomeReady(h, "o1");
    await advance();
    expect((await step(r.id, "o1")).status).toBe("succeeded");
    expect((await step(r.id, "o2")).status).toBe("pending");
    expect((await getRollout(h.db, r.id))?.paused_reason).toBe(
      "waiting for support",
    );
    await resumeRollout(h.deps, owner, r.id);
    await advance();
    expect((await step(r.id, "o2")).status).toBe("applying");
  });

  it("retry runs a failed step again at once and resumes; resume alone is refused while it is failed", async () => {
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await expect(resumeRollout(h.deps, owner, r.id)).rejects.toThrow(
      /Retry or skip own-o1/,
    );
    await retryRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    expect((await getRollout(h.db, r.id))?.status).toBe("active");
    await advance();
    expect(await step(r.id, "o1")).toMatchObject({
      status: "applying",
      attempts: 2,
    });
    expect((await instance(h, "o1")).failed_digest).toBeNull();
  });

  it("skip sends a failed step's instance back and resumes with the next one", async () => {
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await skipRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    expect(await step(r.id, "o1")).toMatchObject({
      status: "skipped",
      target_moved: false,
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    await advance();
    expect((await step(r.id, "o2")).status).toBe("applying");
  });

  it("cancel skips what waits, sends failed instances back, lets the moving one settle, keeps the plan's target", async () => {
    await readyInstance(h, appId, {
      id: "o3",
      planId: "p-pro",
      kind: "own",
      createdAt: "2026-10-01T00:00:03.000Z",
    });
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await skipRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    await advance(); // o2 applying
    await cancelRollout(h.deps, owner, r.id);
    expect((await getRollout(h.db, r.id))?.status).toBe("cancelled");
    expect((await step(r.id, "o3")).status).toBe("skipped");
    expect((await step(r.id, "o2")).status).toBe("applying");
    await becomeReady(h, "o2");
    await advance();
    expect((await step(r.id, "o2")).status).toBe("succeeded");
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.1");
  });

  it("is for operators and release managers; unknown ids are NOT_FOUND", async () => {
    const r = await start();
    await expect(pauseRollout(h.deps, stranger, r.id)).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
    await expect(pauseRollout(h.deps, owner, "nope")).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
    await expect(skipRolloutStep(h.deps, owner, "nope")).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
  });

  it("cancel leaves a retried step's instance on its old release (a failure already sent it back)", async () => {
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await pauseRollout(h.deps, owner, r.id);
    await retryRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    expect(await step(r.id, "o1")).toMatchObject({
      status: "pending",
      target_moved: false,
    });
    await cancelRollout(h.deps, owner, r.id);
    expect(await step(r.id, "o1")).toMatchObject({
      status: "skipped",
      target_moved: false,
    });
    expect(await instance(h, "o1")).toMatchObject({
      target_version: "1.4.0",
      failed_digest: null,
    });
  });

  it("pause is idempotent; a finished rollout is neither paused nor resumed", async () => {
    const r = await start();
    await pauseRollout(h.deps, owner, r.id);
    await pauseRollout(h.deps, owner, r.id);
    await cancelRollout(h.deps, owner, r.id);
    await expect(pauseRollout(h.deps, owner, r.id)).rejects.toThrow(
      /cancelled/,
    );
    await expect(resumeRollout(h.deps, owner, r.id)).rejects.toThrow(
      /cancelled/,
    );
    await expect(cancelRollout(h.deps, owner, r.id)).rejects.toThrow(
      /cancelled/,
    );
  });
});
