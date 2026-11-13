import { afterEach, describe, expect, it } from "vitest";
import { listAudit } from "../audit/repo.js";
import { advanceSwitchoversOnce } from "../switchover/runner.js";
import { confirmSwitchover } from "../switchover/service.js";
import { admin, owner } from "./harness.js";
import { drive, flow, HOLDER, type Flow } from "./switchover-flow-fixtures.js";
import type { Caller } from "../auth.js";

let f: Flow | null = null;
afterEach(async () => {
  await f?.h.close();
  f = null;
});
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};
const HOUR = 3_600_000;

describe("confirmSwitchover", () => {
  it("only the holder of that switch-over; not before the new instance is linked", async () => {
    f = await flow();
    await expect(confirmSwitchover(f.h.deps, holder, f.sw.id)).rejects.toThrow(
      /nothing to confirm yet/,
    );
    // Neither an admin, a stranger nor an unknown id may: always "not found".
    for (const who of [admin, owner])
      await expect(confirmSwitchover(f.h.deps, who, f.sw.id)).rejects.toThrow(
        /not found/,
      );
    await expect(confirmSwitchover(f.h.deps, holder, "nope")).rejects.toThrow(
      /not found/,
    );
  });

  it("confirms once linked; the runner then finishes it and starts the old environment's hold clock", async () => {
    f = await flow();
    await drive(f, "AWAITING_CONFIRMATION");
    const mixed = {
      ...holder,
      address: HOLDER.toUpperCase().replace("0X", "0x"),
    };
    const row = await confirmSwitchover(f.h.deps, mixed, f.sw.id);
    expect(row.confirmed_at).not.toBeNull();
    expect(row.state).toBe("AWAITING_CONFIRMATION");
    expect(
      (await confirmSwitchover(f.h.deps, holder, f.sw.id)).confirmed_at,
    ).toBe(row.confirmed_at);
    const audit = await listAudit(f.h.db, f.appId, { limit: 200 });
    expect(
      audit.filter((a) => a.action === "switchover.confirmed"),
    ).toHaveLength(1);
    await advanceSwitchoversOnce(f.h.deps);
    const done = await f.row();
    expect(done.state).toBe("DONE");
    // Confirmed within the 72 h: done now, not after the silence.
    expect(Date.parse(done.done_at!) - f.h.deps.now().getTime()).toBeLessThan(
      HOUR,
    );
    expect(done.hold_until).not.toBeNull();
  });

  it("a dry run has no holder to confirm", async () => {
    f = await flow({ mode: "dry_run", frozen: false });
    await expect(confirmSwitchover(f.h.deps, holder, f.sw.id)).rejects.toThrow(
      /not found/,
    );
  });
});
