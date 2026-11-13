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

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's local weekday/hour/minute formatter; null for an unknown zone (not cached). */
function formatterOf(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
    return f;
  } catch {
    return null;
  }
}

const validTimeZone = (tz: string) => formatterOf(tz) !== null;

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

/** A window that is never open: what a stored window that does not parse reads as. */
const NEVER: UpdateWindow = Object.freeze({
  days: [],
  start: "",
  end: "",
  timeZone: "",
}) as UpdateWindow;

/**
 * The stored window; null: none (any time). Never throws: JSON that does not
 * parse comes back as a window that is never open (fail closed, as every
 * window that does not check: see usable).
 */
export function parseWindow(
  json: string | null | undefined,
): UpdateWindow | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object") return v as UpdateWindow;
  } catch {
    // fall through: never open
  }
  return NEVER;
}

/** Whether a (stored) window is well formed: what checkWindow accepts. */
export function usable(w: UpdateWindow): boolean {
  return (
    Array.isArray(w.days) &&
    w.days.length > 0 &&
    w.days.every((x) => Number.isInteger(x) && x >= 1 && x <= 7) &&
    typeof w.start === "string" &&
    HHMM.test(w.start) &&
    typeof w.end === "string" &&
    HHMM.test(w.end) &&
    typeof w.timeZone === "string" &&
    validTimeZone(w.timeZone)
  );
}

function local(at: Date, timeZone: string): { day: number; minute: number } {
  const p = Object.fromEntries(
    formatterOf(timeZone)!
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    day: WEEKDAY[p.weekday],
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/**
 * Whether `at` is inside the window. start == end: the whole of each listed
 * day (local midnight to midnight). False, never a throw, for a window that
 * is not usable or a date that is not one (fail closed).
 */
export function inWindow(w: UpdateWindow, at: Date): boolean {
  if (Number.isNaN(at.getTime()) || !usable(w)) return false;
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

const SEGMENT_MS = 30 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

/**
 * The first minute at or after `from` inside the window; `from` itself when
 * inside; null when there is none within 8 days (a window that is not usable,
 * or a date that is not one): never due.
 *
 * Steps by boundaries, not minutes: zones change their offset only on UTC
 * half hours, so within each half hour local time runs straight and the
 * window can only open where local time reaches its start or midnight, or at
 * the half hour itself (a DST jump).
 */
export function nextWindowStart(w: UpdateWindow, from: Date): Date | null {
  if (Number.isNaN(from.getTime()) || !usable(w)) return null;
  if (inWindow(w, from)) return from;
  const first = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  const last = from.getTime() + 8 * DAY_MINUTES * MINUTE_MS;
  const entries = [minutesOf(w.start), 0];
  for (
    let g = Math.floor(first / SEGMENT_MS) * SEGMENT_MS;
    g <= last;
    g += SEGMENT_MS
  ) {
    const m = local(new Date(g), w.timeZone).minute;
    const candidates = [
      g,
      ...entries.map(
        (e) => g + ((e - m + DAY_MINUTES) % DAY_MINUTES) * MINUTE_MS,
      ),
      ...(g < first && first < g + SEGMENT_MS ? [first] : []),
    ]
      .filter((c) => c >= first && c < g + SEGMENT_MS)
      .sort((a, b) => a - b);
    for (const c of candidates)
      if (inWindow(w, new Date(c))) return new Date(c);
  }
  return null;
}
