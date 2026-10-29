// Validation for the environment notification webhook
// (`VetraCloudEnvironmentState.notifications`).
//
// Runs inside the SET_NOTIFICATION_WEBHOOK reducer, so it must stay pure and
// synchronous: string/URL parsing only, no DNS. The processor re-checks the
// stored URL with the same function right before delivering, so a URL that
// was accepted by an older reducer can never be POSTed to if it now fails.

/** Event names an owner can subscribe the webhook to. */
export const NOTIFICATION_EVENTS = [
  "deployment.succeeded",
  "deployment.failed",
  "environment.terminated",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const MAX_URL_LENGTH = 2048;

/** Hostname suffixes that only resolve inside a cluster or a LAN. */
const INTERNAL_SUFFIXES = [
  "localhost",
  ".local",
  ".internal",
  ".svc",
  ".cluster.local",
  ".lan",
  ".home.arpa",
];

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

/**
 * Returns null when `raw` is an acceptable webhook URL, otherwise a short
 * reason. Accepted: absolute https URLs to a public hostname, without
 * embedded credentials. Rejected: other schemes, localhost / cluster-internal
 * names, private or loopback IPv4 literals, and any IPv6 literal — the
 * processor POSTs from inside the cluster, so internal targets are refused.
 */
export function webhookUrlProblem(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) {
    return `must be at most ${MAX_URL_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) {
    return "must not contain credentials";
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "must have a hostname";
  if (host.startsWith("[")) return "must not be an IPv6 literal";
  if (!host.includes(".")) return "must be a public hostname";
  if (
    INTERNAL_SUFFIXES.some(
      (s) => host === s.replace(/^\./, "") || host.endsWith(s),
    )
  ) {
    return "must be a public hostname";
  }
  if (isPrivateIPv4(host)) return "must not be a private IP address";
  return null;
}

/**
 * Normalises the subscribed events: trims, drops empties and duplicates.
 * `null`/`undefined` means "all events".
 */
export function normalizeNotificationEvents(
  events: readonly string[] | null | undefined,
): string[] {
  if (events == null) return [...NOTIFICATION_EVENTS];
  const out: string[] = [];
  for (const e of events) {
    const name = e.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
