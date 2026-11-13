import { describe, expect, it } from "vitest";
import { holderNotices } from "../holders/notices.js";

const NOW = "2026-11-01T00:00:00.000Z";
const iso = (days: number, from = NOW) =>
  new Date(Date.parse(from) + days * 86_400_000).toISOString();
const base = {
  now: NOW,
  endAt: null,
  endedAt: null,
  stopped: false,
  stopAfterDays: 14,
  destroy: { enabled: false, afterDays: 90 },
};

describe("holderNotices", () => {
  it("says nothing 8 days before the end, EXPIRING at 6", () => {
    expect(holderNotices({ ...base, endAt: iso(8) })).toEqual([]);
    expect(holderNotices({ ...base, endAt: iso(6) })).toEqual([
      expect.objectContaining({ kind: "EXPIRING", at: iso(6) }),
    ]);
  });
  it("an ended licence: the stop is pending until stopAfterDays", () => {
    const n = holderNotices({ ...base, endedAt: iso(-3) });
    expect(n).toEqual([
      expect.objectContaining({ kind: "ENDED_STOP_PENDING", at: iso(11) }),
    ]);
  });
  it("stopped with destroy off: STOPPED, no deletion date", () => {
    const n = holderNotices({ ...base, endedAt: iso(-20), stopped: true });
    expect(n).toEqual([expect.objectContaining({ kind: "STOPPED", at: null })]);
  });
  it("past the stop date counts as stopped even before Vetra slept it", () => {
    const n = holderNotices({ ...base, endedAt: iso(-15) });
    expect(n.map((x) => x.kind)).toEqual(["STOPPED"]);
  });
  it("destroy on: STOPPED_DELETE_PENDING, then DELETE_IMMINENT in the last 7 days", () => {
    const destroy = { enabled: true, afterDays: 90 };
    const ended = iso(-20);
    expect(
      holderNotices({ ...base, destroy, endedAt: ended, stopped: true }),
    ).toEqual([
      expect.objectContaining({
        kind: "STOPPED_DELETE_PENDING",
        at: iso(90, ended),
      }),
    ]);
    const late = iso(-85);
    expect(
      holderNotices({ ...base, destroy, endedAt: late, stopped: true }),
    ).toEqual([
      expect.objectContaining({ kind: "DELETE_IMMINENT", at: iso(90, late) }),
    ]);
  });
  it("an App being discontinued says so", () => {
    expect(
      holderNotices({ ...base, appDeletionDueAt: iso(30) }).map((x) => x.kind),
    ).toEqual(["APP_DISCONTINUED"]);
  });
});
