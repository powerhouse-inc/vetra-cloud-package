import { describe, expect, it } from "vitest";
import {
  checkWindow,
  inWindow,
  nextWindowStart,
  parseWindow,
} from "../rollouts/window.js";

const d = (s: string) => new Date(s);
const NIGHTS = {
  days: [6, 7],
  start: "22:00",
  end: "06:00",
  timeZone: "Europe/Berlin",
};

describe("update windows (spec 14.8)", () => {
  it("runs past midnight from the days it starts on", () => {
    // Sat 2026-11-14 22:30 CET: in.
    expect(inWindow(NIGHTS, d("2026-11-14T21:30:00.000Z"))).toBe(true);
    // Mon 2026-11-16 05:00 CET: Sunday's night, in.
    expect(inWindow(NIGHTS, d("2026-11-16T04:00:00.000Z"))).toBe(true);
    // Fri 2026-11-13 23:00 CET: Friday is not a day of the window.
    expect(inWindow(NIGHTS, d("2026-11-13T22:00:00.000Z"))).toBe(false);
    // Mon 2026-11-16 06:00 CET: the end is excluded.
    expect(inWindow(NIGHTS, d("2026-11-16T05:00:00.000Z"))).toBe(false);
    // Thu 2026-11-12 11:00 CET -> Sat 22:00 CET.
    expect(
      nextWindowStart(NIGHTS, d("2026-11-12T10:00:00.000Z"))?.toISOString(),
    ).toBe("2026-11-14T21:00:00.000Z");
  });

  it("follows the DST changes of the zone", () => {
    const early = {
      days: [1, 2, 3, 4, 5, 6, 7],
      start: "02:00",
      end: "04:00",
      timeZone: "Europe/Berlin",
    };
    // 2026-03-29: 02:00 CET does not exist; the next local 02:00-04:00 minute is 03:00 CEST = 01:00Z.
    expect(inWindow(early, d("2026-03-29T00:59:00.000Z"))).toBe(false);
    expect(
      nextWindowStart(early, d("2026-03-29T00:30:00.000Z"))?.toISOString(),
    ).toBe("2026-03-29T01:00:00.000Z");
    // 2026-10-25: 02:00-03:00 happens twice (CEST, then CET); both are in.
    const sunday = {
      days: [7],
      start: "02:00",
      end: "03:00",
      timeZone: "Europe/Berlin",
    };
    expect(inWindow(sunday, d("2026-10-25T00:30:00.000Z"))).toBe(true);
    expect(inWindow(sunday, d("2026-10-25T01:30:00.000Z"))).toBe(true);
    expect(inWindow(sunday, d("2026-10-25T02:00:00.000Z"))).toBe(false);
  });

  it("start == end is the whole day; a time inside is its own next start", () => {
    const sundays = {
      days: [7],
      start: "00:00",
      end: "00:00",
      timeZone: "UTC",
    };
    const at = d("2026-11-15T13:37:00.000Z");
    expect(inWindow(sundays, at)).toBe(true);
    expect(nextWindowStart(sundays, at)).toBe(at);
  });

  it("checks and normalises; parses stored JSON", () => {
    expect(
      checkWindow({
        days: [7, 6, 6],
        start: "22:00",
        end: "06:00",
        timeZone: "Europe/Berlin",
      }).days,
    ).toEqual([6, 7]);
    for (const bad of [
      { days: [], start: "22:00", end: "06:00", timeZone: "UTC" },
      { days: [8], start: "22:00", end: "06:00", timeZone: "UTC" },
      { days: [1], start: "24:00", end: "06:00", timeZone: "UTC" },
      { days: [1], start: "7:00", end: "08:00", timeZone: "UTC" },
      { days: [1], start: "07:00", end: "08:00", timeZone: "Mars/Olympus" },
    ])
      expect(() => checkWindow(bad)).toThrow();
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow(JSON.stringify(NIGHTS))).toEqual(NIGHTS);
  });

  it("fails closed: a stored window that does not parse or check is never open, and nothing throws", () => {
    const broken = [
      parseWindow("{not json"),
      parseWindow("null"),
      parseWindow(JSON.stringify({ ...NIGHTS, timeZone: "Mars/Olympus" })),
      parseWindow(JSON.stringify({ days: [6], end: "06:00", timeZone: "UTC" })),
      parseWindow(JSON.stringify({ ...NIGHTS, days: [] })),
      parseWindow(JSON.stringify({ ...NIGHTS, days: "6" })),
    ];
    for (const w of broken) {
      expect(w).not.toBeNull();
      expect(inWindow(w!, d("2026-11-14T21:30:00.000Z"))).toBe(false);
      expect(nextWindowStart(w!, d("2026-11-14T21:30:00.000Z"))).toBeNull();
    }
    expect(inWindow(NIGHTS, new Date("garbage"))).toBe(false);
    expect(nextWindowStart(NIGHTS, new Date("garbage"))).toBeNull();
  });

  it("runs past midnight across the spring DST change", () => {
    const saturday = { ...NIGHTS, days: [6] };
    // Sat 2026-03-28 22:00 CET = 21:00Z.
    expect(
      nextWindowStart(saturday, d("2026-03-28T10:00:00.000Z"))?.toISOString(),
    ).toBe("2026-03-28T21:00:00.000Z");
    // Sun 03:30 CEST (01:30Z) and 05:59 CEST (03:59Z) are in; 06:00 CEST (04:00Z) is out.
    expect(inWindow(saturday, d("2026-03-29T01:30:00.000Z"))).toBe(true);
    expect(inWindow(saturday, d("2026-03-29T03:59:00.000Z"))).toBe(true);
    expect(inWindow(saturday, d("2026-03-29T04:00:00.000Z"))).toBe(false);
    // From inside Sunday morning's tail, after it: the next Saturday night.
    expect(
      nextWindowStart(saturday, d("2026-03-29T04:00:00.000Z"))?.toISOString(),
    ).toBe("2026-04-04T20:00:00.000Z");
  });

  it("finds a one-minute window, to the minute", () => {
    const minute = {
      days: [1, 2, 3, 4, 5, 6, 7],
      start: "10:00",
      end: "10:01",
      timeZone: "Asia/Kolkata",
    };
    // 10:00 IST = 04:30Z; from 04:31Z the next one is tomorrow.
    expect(
      nextWindowStart(minute, d("2026-11-12T04:31:00.000Z"))?.toISOString(),
    ).toBe("2026-11-13T04:30:00.000Z");
    expect(
      nextWindowStart(minute, d("2026-11-12T04:29:30.000Z"))?.toISOString(),
    ).toBe("2026-11-12T04:30:00.000Z");
  });

  it("start == end is the whole of each listed day, local midnight to midnight", () => {
    const sundays = {
      days: [7],
      start: "00:00",
      end: "00:00",
      timeZone: "Europe/Berlin",
    };
    // Sat 23:59 CET out, Sun 00:00 CET (Sat 23:00Z) in, Mon 00:00 CET out.
    expect(inWindow(sundays, d("2026-11-14T22:59:00.000Z"))).toBe(false);
    expect(inWindow(sundays, d("2026-11-14T23:00:00.000Z"))).toBe(true);
    expect(inWindow(sundays, d("2026-11-15T23:00:00.000Z"))).toBe(false);
    expect(
      nextWindowStart(sundays, d("2026-11-16T09:00:00.000Z"))?.toISOString(),
    ).toBe("2026-11-21T23:00:00.000Z");
  });
});
