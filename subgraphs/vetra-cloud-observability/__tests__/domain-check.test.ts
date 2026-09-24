import { describe, expect, it } from "vitest";

import {
  checkCustomDomain,
  matchCustomDomainHosts,
  type HostProbe,
} from "../domain-check.js";

/*
  The custom-domain status drives the environment page: service cards switch to
  the custom hosts only when domainResolves AND tlsCertValid are true. The TLS
  half used to read each ingress's cert Secret, which the switchboard's service
  account may not read in tenant namespaces — so it was always "invalid". It now
  handshakes with the host instead; these tests pin the aggregation.
*/

const FUTURE = new Date(Date.now() + 60 * 24 * 3600 * 1000);
const SOONER = new Date(Date.now() + 10 * 24 * 3600 * 1000);

function probe(overrides: {
  resolves?: Record<string, boolean>;
  tls?: Record<string, { valid: boolean; expiresAt: Date | null }>;
} = {}): HostProbe {
  return {
    resolves: async (host) => overrides.resolves?.[host] ?? true,
    tls: async (host) => overrides.tls?.[host] ?? { valid: true, expiresAt: FUTURE },
  };
}

describe("matchCustomDomainHosts", () => {
  it("matches the apex and <svc>.<domain> hosts, nothing else", () => {
    expect(
      matchCustomDomainHosts(
        [
          "connect.knowledge-vault.vetra.io",
          "switchboard.knowledge-vault.vetra.io",
          "light-colt-connect.vetra.io",
          "notknowledge-vault.vetra.io",
          "knowledge-vault.vetra.io",
        ],
        "knowledge-vault.vetra.io",
      ),
    ).toEqual([
      "connect.knowledge-vault.vetra.io",
      "switchboard.knowledge-vault.vetra.io",
      "knowledge-vault.vetra.io",
    ]);
  });
});

describe("checkCustomDomain", () => {
  const hosts = ["connect.kv.example", "switchboard.kv.example"];

  it("is all-null without a custom domain", async () => {
    expect(await checkCustomDomain(hosts, null, probe())).toEqual({
      domainResolves: null,
      tlsCertValid: null,
      tlsCertExpiresAt: null,
    });
  });

  it("is all-null when no ingress serves the domain yet (deploy still rolling)", async () => {
    expect(await checkCustomDomain(["other.example"], "kv.example", probe())).toEqual({
      domainResolves: null,
      tlsCertValid: null,
      tlsCertExpiresAt: null,
    });
  });

  it("is green when every host resolves and presents a valid cert", async () => {
    const r = await checkCustomDomain(hosts, "kv.example", probe());
    expect(r.domainResolves).toBe(1);
    expect(r.tlsCertValid).toBe(1);
    expect(r.tlsCertExpiresAt).toBe(FUTURE.toISOString());
  });

  it("reports the earliest expiry across hosts", async () => {
    const r = await checkCustomDomain(
      hosts,
      "kv.example",
      probe({ tls: { "switchboard.kv.example": { valid: true, expiresAt: SOONER } } }),
    );
    expect(r.tlsCertExpiresAt).toBe(SOONER.toISOString());
  });

  it("is red on DNS when any host fails to resolve", async () => {
    const r = await checkCustomDomain(
      hosts,
      "kv.example",
      probe({ resolves: { "connect.kv.example": false } }),
    );
    expect(r.domainResolves).toBe(0);
  });

  it("is red on TLS when any host's cert is invalid", async () => {
    const r = await checkCustomDomain(
      hosts,
      "kv.example",
      probe({ tls: { "connect.kv.example": { valid: false, expiresAt: FUTURE } } }),
    );
    expect(r.tlsCertValid).toBe(0);
    expect(r.domainResolves).toBe(1);
  });

  it("skips the handshake for a host that does not resolve (TLS red, no throw)", async () => {
    let tlsCalls = 0;
    const r = await checkCustomDomain(["connect.kv.example"], "kv.example", {
      resolves: async () => false,
      tls: async () => {
        tlsCalls++;
        return { valid: true, expiresAt: FUTURE };
      },
    });
    expect(tlsCalls).toBe(0);
    expect(r).toEqual({ domainResolves: 0, tlsCertValid: 0, tlsCertExpiresAt: null });
  });

  it("treats a probe that throws as a failure, not a crash", async () => {
    const r = await checkCustomDomain(["connect.kv.example"], "kv.example", {
      resolves: async () => true,
      tls: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(r.tlsCertValid).toBe(0);
  });
});
