export type LicenseStatusName =
  | "ISSUED"
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "REPLACED";

export interface LicenseRow {
  id: string;
  status: LicenseStatusName;
  /** ISO-8601, normalised on write. Lexical comparison is safe for this form. */
  start: string | null;
  end: string | null;
}

export interface LicenseTransitions {
  toActivate: string[];
  toExpire: string[];
}

/**
 * Pure. Given every licence of an app and the current instant, decide which
 * must move. A licence already past its end is expired without first being
 * activated — activating it would provision an environment only to tear it
 * down on the next tick.
 */
export function computeLicenseTransitions(
  rows: LicenseRow[],
  nowIso: string,
): LicenseTransitions {
  const toActivate: string[] = [];
  const toExpire: string[] = [];

  for (const r of rows) {
    const past = r.end !== null && r.end <= nowIso;

    if (r.status === "ISSUED") {
      if (past) {
        toExpire.push(r.id);
      } else if (r.start !== null && r.start <= nowIso) {
        toActivate.push(r.id);
      }
      continue;
    }

    if (r.status === "ACTIVE" && past) {
      toExpire.push(r.id);
    }
  }

  return { toActivate, toExpire };
}
