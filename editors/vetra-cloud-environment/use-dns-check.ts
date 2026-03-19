import { useCallback, useEffect, useRef, useState } from "react";

const LB_IPV4 = "138.199.129.93";

interface DnsCheckResult {
  verified: boolean;
  checking: boolean;
  error: string | null;
}

async function checkDns(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as {
      Answer?: { data: string }[];
    };
    return (
      data.Answer?.some((a) => a.data === LB_IPV4) ?? false
    );
  } catch {
    return false;
  }
}

export function useDnsCheck(domain: string | null | undefined): DnsCheckResult {
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runCheck = useCallback(async () => {
    if (!domain) return;
    setChecking(true);
    setError(null);
    try {
      const result = await checkDns(domain);
      setVerified(result);
    } catch {
      setError("DNS check failed");
    } finally {
      setChecking(false);
    }
  }, [domain]);

  useEffect(() => {
    if (!domain) {
      setVerified(false);
      setChecking(false);
      setError(null);
      return;
    }

    runCheck();

    intervalRef.current = setInterval(runCheck, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [domain, runCheck]);

  return { verified, checking, error };
}

export const LB_CONFIG = {
  ipv4: LB_IPV4,
  ipv6: "2a01:4f8:c01e:796::1",
};
