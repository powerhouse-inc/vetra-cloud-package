import { appsError } from "../errors.js";

/** When a plan's instances may be updated (spec 14.8; decision R12). */
export interface UpdateWindow {
  /** ISO weekdays, 1 = Monday … 7 = Sunday: the days the window starts on. */
  days: number[];
  /** Local "HH:MM" (24 h). end <= start runs past midnight; equal: the whole day. */
  start: string;
  end: string;
  /** IANA time zone, e.g. Europe/Berlin. */
  timeZone: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (s: string) => {
  const m = HHMM.exec(s)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};
const MINUTE_MS = 60_000;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws BAD_USER_INPUT on anything malformed; days come back sorted and unique. */
export function checkWindow(w: UpdateWindow): UpdateWindow {
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  if (
    days.length === 0 ||
    days.some((x) => !Number.isInteger(x) || x < 1 || x > 7)
  )
    throw appsError(
      "BAD_USER_INPUT",
      "An update window's days are 1 (Monday) to 7 (Sunday), at least one",
    );
  if (!HHMM.test(w.start) || !HHMM.test(w.end))
    throw appsError(
      "BAD_USER_INPUT",
      "An update window's start and end are HH:MM (24 h)",
    );
  if (!validTimeZone(w.timeZone))
    throw appsError(
      "BAD_USER_INPUT",
      `Unknown time zone ${w.timeZone} (use an IANA name such as Europe/Berlin)`,
    );
  return { days, start: w.start, end: w.end, timeZone: w.timeZone };
}

export function parseWindow(
  json: string | null | undefined,
): UpdateWindow | null {
  return json ? (JSON.parse(json) as UpdateWindow) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(at: Date, timeZone: string): { day: number; minute: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(at).map((x) => [x.type, x.value]),
  );
  return {
    day: WEEKDAY[p.weekday],
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function inWindow(w: UpdateWindow, at: Date): boolean {
  const { day, minute } = local(at, w.timeZone);
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  if (s === e) return w.days.includes(day);
  if (s < e) return w.days.includes(day) && minute >= s && minute < e;
  const previous = day === 1 ? 7 : day - 1;
  return (
    (w.days.includes(day) && minute >= s) ||
    (w.days.includes(previous) && minute < e)
  );
}

/** The first minute at or after `from` inside the window; `from` itself when inside. */
export function nextWindowStart(w: UpdateWindow, from: Date): Date {
  if (inWindow(w, from)) return from;
  const last = from.getTime() + 8 * 24 * 60 * MINUTE_MS;
  for (
    let t = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
    t <= last;
    t += MINUTE_MS
  )
    if (inWindow(w, new Date(t))) return new Date(t);
  // Unreachable for a checked window (at least one day a week).
  return from;
}
