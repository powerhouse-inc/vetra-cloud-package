/**
 * User-Agent the observability `clint-pull-worker` stamps on its `/_proxy/routes`
 * poll so the idle signal + wake activator can exclude it as automation. Defined
 * here (the dependency-free policy module) and re-exported by the worker, so the
 * slim housekeeping-service build doesn't drag in the observability subgraph.
 */
export const OBSERVABILITY_PULL_USER_AGENT = "vetra-observability-pull";

/**
 * Studio housekeeping policy — pure decision functions shared by the
 * housekeeping subgraph (sleep/wake mutations, power-state query) and the
 * standalone housekeeping service (idle detector + wake activator).
 *
 * Keeping these pure and dependency-free means both the in-reactor subgraph and
 * the out-of-process activator apply identical rules, and they're trivially
 * unit-testable. See docs/superpowers/specs/2026-06-30-studio-housekeeping-…
 */

// ---------------------------------------------------------------------------
// Proper requests vs. automation ("pings")
// ---------------------------------------------------------------------------

/**
 * Request paths that are automation, never a real user interaction. Matched as
 * exact paths or path prefixes (a trailing `/` marks a prefix family).
 */
export const AUTOMATION_PATHS: readonly string[] = [
  "/_proxy/routes", // observability clint-pull-worker
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/livez",
  "/metrics",
  "/favicon.ico",
  "/.well-known/acme-challenge/", // cert-manager HTTP-01 (prefix)
];

/**
 * User-Agent substrings (lowercased) that mark automation: our own pollers and
 * common uptime/health monitors. Deliberately conservative — generic clients
 * like curl/wget are NOT here, since a real user's CLI uses them.
 */
export const AUTOMATION_USER_AGENTS: readonly string[] = [
  OBSERVABILITY_PULL_USER_AGENT.toLowerCase(),
  "kube-probe",
  "uptime-kuma",
  "uptimerobot",
  "pingdom",
  "statuscake",
  "betteruptime",
  "prometheus",
  "blackbox",
  "grafana",
];

function pathIsAutomation(rawPath: string): boolean {
  // Normalise: strip query/hash, lowercase, drop trailing slash (except root).
  let p = rawPath.split("?")[0].split("#")[0].toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  for (const entry of AUTOMATION_PATHS) {
    if (entry.endsWith("/")) {
      if (p.startsWith(entry) || p + "/" === entry) return true;
    } else if (p === entry) {
      return true;
    }
  }
  return false;
}

/**
 * True when a request is automation (a "ping"), not a proper user request.
 * Used by the idle detector (don't count it as activity) and the wake activator
 * (don't wake a sleeping studio for it).
 */
export function isAutomationRequest(
  path: string | null | undefined,
  userAgent: string | null | undefined,
): boolean {
  if (path && pathIsAutomation(path)) return true;
  if (userAgent) {
    const ua = userAgent.toLowerCase();
    if (AUTOMATION_USER_AGENTS.some((m) => ua.includes(m))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Power state (for the activator + dashboard)
// ---------------------------------------------------------------------------

export type StudioPowerStatus = "AWAKE" | "SLEEPING" | "WAKING" | "UNKNOWN";

/** Subset of the environments read-model row the policy functions need. */
export type EnvRow = {
  status?: string | null;
  owner?: string | null;
  poolState?: string | null;
  tenantId?: string | null;
  subdomain?: string | null;
};

const TRANSITIONAL_STATUSES = new Set([
  "DEPLOYING",
  "CHANGES_PENDING",
  "CHANGES_APPROVED",
  "CHANGES_PUSHED",
]);

/**
 * Map an environment's document status to a coarse power state. In the
 * activator's context a host is only caught while disabled, so `STOPPED`
 * (housekeeping sleep) reads as SLEEPING and a subsequent deploy reads as
 * WAKING; `READY` is AWAKE.
 */
export function deriveStudioPowerState(
  row: EnvRow | null | undefined,
): StudioPowerStatus {
  const status = row?.status ?? "";
  if (status === "STOPPED") return "SLEEPING";
  if (status === "READY") return "AWAKE";
  if (TRANSITIONAL_STATUSES.has(status)) return "WAKING";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Sleep eligibility
// ---------------------------------------------------------------------------

/**
 * Tenants that must never be slept by housekeeping — the hand-managed core
 * tenants (also excluded from the `powerhouse-tenants` ApplicationSet).
 */
export const DEFAULT_NEVER_SLEEP_TENANTS: readonly string[] = [
  "renown",
  "vetra",
  "staging",
  "rfp-hub",
  "defiunited",
  "defiunited-staging",
];

export type EligibilityOptions = {
  /** Extra tenantIds (or subdomains) to never sleep — e.g. VIP customers. */
  allowlist?: Iterable<string>;
  /** Override the core-tenant exclusions (defaults to DEFAULT_NEVER_SLEEP_TENANTS). */
  neverSleepTenants?: Iterable<string>;
};

/**
 * Whether an environment is eligible to be put to sleep:
 *  - it's a claimed studio (`owner` set; not a warm-pool WARMING/AVAILABLE/FAILED env),
 *  - it's currently live (`READY` — never re-sleep one already stopping/deploying),
 *  - it has a routable subdomain,
 *  - it's not a core tenant and not on the never-sleep allowlist.
 */
export function isEligibleForSleep(
  row: EnvRow | null | undefined,
  opts: EligibilityOptions = {},
): boolean {
  if (!row) return false;
  if (row.status !== "READY") return false;
  if (!row.owner) return false;
  if (!row.subdomain) return false;
  if (row.poolState != null && row.poolState !== "CLAIMED") return false;

  const never = new Set<string>([
    ...(opts.neverSleepTenants ?? DEFAULT_NEVER_SLEEP_TENANTS),
    ...(opts.allowlist ?? []),
  ]);
  if (row.tenantId && never.has(row.tenantId)) return false;
  if (row.subdomain && never.has(row.subdomain)) return false;

  return true;
}
