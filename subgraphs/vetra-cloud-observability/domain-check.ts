import { resolve4 } from "node:dns/promises";
import { connect } from "node:tls";

/**
 * Aggregate DNS + TLS status for an environment's custom domain, as shown on
 * the vetra.io environment page (the service cards switch to the custom hosts
 * only when both are green).
 *
 * TLS is judged by handshaking with each host — chain verified, SNI set — not
 * by reading the cert-manager Secret: the switchboard's service account may
 * not read Secrets in tenant namespaces (it shouldn't — every tenant credential
 * lives there), so the Secret-based check reported every domain as invalid.
 * The handshake also tests what a visitor actually gets.
 */
export interface DomainCheck {
  domainResolves: number | null;
  tlsCertValid: number | null;
  tlsCertExpiresAt: string | null;
}

export interface HostProbe {
  resolves(host: string): Promise<boolean>;
  tls(host: string): Promise<{ valid: boolean; expiresAt: Date | null }>;
}

const EMPTY: DomainCheck = {
  domainResolves: null,
  tlsCertValid: null,
  tlsCertExpiresAt: null,
};

const TLS_TIMEOUT_MS = 5_000;

/**
 * Ingress hosts that serve `customDomain`: the domain itself (apex mode) or
 * `<svc>.<domain>` (non-apex mode). A plain `endsWith(domain)` would also
 * match `notknowledge-vault.vetra.io`.
 */
export function matchCustomDomainHosts(hosts: string[], customDomain: string): string[] {
  const suffix = `.${customDomain}`;
  return hosts.filter((h) => h === customDomain || h.endsWith(suffix));
}

export const defaultHostProbe: HostProbe = {
  async resolves(host) {
    try {
      return (await resolve4(host)).length > 0;
    } catch {
      return false;
    }
  },
  tls(host) {
    return new Promise((resolve) => {
      const socket = connect({
        host,
        port: 443,
        servername: host,
        // Read the cert even when invalid; validity comes from `authorized`.
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      });
      const done = (valid: boolean, expiresAt: Date | null) => {
        socket.destroy();
        resolve({ valid, expiresAt });
      };
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        const expiresAt = cert?.valid_to ? new Date(cert.valid_to) : null;
        const unexpired = expiresAt !== null && expiresAt > new Date();
        done(socket.authorized && unexpired, expiresAt);
      });
      socket.once("timeout", () => done(false, null));
      socket.once("error", () => done(false, null));
    });
  },
};

/**
 * `domainResolves` / `tlsCertValid` are green only if every matched host is
 * green, red if any fails, and all-null when there is no custom domain or no
 * ingress serves it yet (a deploy still rolling out).
 */
export async function checkCustomDomain(
  ingressHosts: string[],
  customDomain: string | null,
  probe: HostProbe = defaultHostProbe,
): Promise<DomainCheck> {
  if (!customDomain) return { ...EMPTY };
  const hosts = matchCustomDomainHosts(ingressHosts, customDomain);
  if (hosts.length === 0) return { ...EMPTY };

  let resolvesAll = true;
  let tlsAll = true;
  let earliest: Date | null = null;

  for (const host of hosts) {
    const resolves = await probe.resolves(host).catch(() => false);
    if (!resolves) {
      // Nothing to handshake with; the cert can't be judged valid.
      resolvesAll = false;
      tlsAll = false;
      continue;
    }
    const tls = await probe.tls(host).catch(() => ({ valid: false, expiresAt: null }));
    if (!tls.valid) tlsAll = false;
    if (tls.expiresAt && (earliest === null || tls.expiresAt < earliest)) {
      earliest = tls.expiresAt;
    }
  }

  return {
    domainResolves: resolvesAll ? 1 : 0,
    tlsCertValid: tlsAll ? 1 : 0,
    tlsCertExpiresAt: earliest ? earliest.toISOString() : null,
  };
}
