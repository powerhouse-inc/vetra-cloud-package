import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Caller } from "../auth.js";
import { owner, stranger, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  HOLDER_B,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { myInstancesFor } from "../plans/holder-view.js";
import { getApp } from "../repo.js";
import { stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import { pauseRollout } from "../rollouts/controls.js";
import { updateInstanceNow } from "../rollouts/holder.js";

const holder = (address: string): Caller => ({ ...stranger, address });
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
  await h.db
    .updateTable("releases")
    .set({ customer_notes: "Faster exports" })
    .where("version", "=", "1.4.1")
    .execute();
});
afterEach(async () => {
  await h.close();
});
const start = (noticeHours: number) =>
  startRollout(h.deps, owner, {
    appId,
    version: "1.4.1",
    planIds: ["p-pro"],
    noticeHours,
  });

describe("holders are told and may update now (spec 7 step 3, 14.8)", () => {
  it("shows the coming update with its notes and due date", async () => {
    const r = await start(24);
    const [mine] = await myInstancesFor(h.deps, holder(HOLDER_A));
    expect(mine.update).toEqual({
      rolloutId: r.id,
      version: "1.4.1",
      dueAt: (await stepsOf(h.db, r.id))[0].due_at,
      notes: "Faster exports",
      paused: false,
      canUpdateNow: true,
    });
  });

  it("moves the due date to the plan's next window", async () => {
    await h.db
      .updateTable("plans")
      .set({
        update_window: JSON.stringify({
          days: [6, 7],
          start: "00:00",
          end: "00:00",
          timeZone: "UTC",
        }),
      })
      .where("id", "=", "p-pro")
      .execute();
    await start(0);
    const [mine] = await myInstancesFor(h.deps, holder(HOLDER_A));
    expect(mine.update?.dueAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("a window that never opens (unreadable) gives no due date: never due", async () => {
    await h.db
      .updateTable("plans")
      .set({ update_window: "not json" })
      .where("id", "=", "p-pro")
      .execute();
    await start(0);
    const [mine] = await myInstancesFor(h.deps, holder(HOLDER_A));
    expect(mine.update).toMatchObject({ version: "1.4.1", dueAt: null });
  });

  it("update now starts the holder's step at once, before the notice and the others; only for its holder, never while paused", async () => {
    const r = await start(24);
    expect(
      await updateInstanceNow(h.deps, holder(HOLDER_A), "o1"),
    ).toMatchObject({ canUpdateNow: false });
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect((await stepsOf(h.db, r.id)).map((s) => s.status)).toEqual([
      "applying",
      "pending",
    ]);
    await expect(
      updateInstanceNow(h.deps, holder(HOLDER_B), "o1"),
    ).rejects.toMatchObject(code("NOT_FOUND"));
    await pauseRollout(h.deps, owner, r.id);
    await expect(
      updateInstanceNow(h.deps, holder(HOLDER_B), "o2"),
    ).rejects.toThrow(/paused/);
    expect(
      (await listAudit(h.db, appId, { limit: 50 })).filter(
        (a) => a.action === "instance.update_requested",
      ),
    ).toHaveLength(1);
  });
});
