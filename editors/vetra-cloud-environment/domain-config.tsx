import { TextInput } from "@powerhousedao/document-engineering";
import { useCallback, useEffect, useState } from "react";
import { useDnsCheck, LB_CONFIG } from "./use-dns-check.js";

interface DomainConfigProps {
  subdomain: string | null;
  customDomain: string | null;
  onCustomDomainChange: (domain: string) => void;
}

export function DomainConfig({
  subdomain,
  customDomain,
  onCustomDomainChange,
}: DomainConfigProps) {
  const [localDomain, setLocalDomain] = useState(customDomain ?? "");
  const [committed, setCommitted] = useState(!!customDomain);

  // Sync local state when prop changes (e.g. from another client)
  useEffect(() => {
    if (customDomain !== null && customDomain !== localDomain) {
      setLocalDomain(customDomain);
      setCommitted(true);
    }
     
  }, [customDomain]);

  // Use the committed local domain for DNS checks (so it works immediately after blur)
  const domainToCheck = committed && localDomain.trim() ? localDomain.trim() : null;
  const { verified, checking } = useDnsCheck(domainToCheck);

  const commitDomain = useCallback(() => {
    const trimmed = localDomain.trim();
    if (trimmed !== (customDomain ?? "")) {
      onCustomDomainChange(trimmed);
    }
    setCommitted(!!trimmed);
  }, [localDomain, customDomain, onCustomDomainChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") commitDomain();
    },
    [commitDomain],
  );

  const systemDomain = subdomain ? `${subdomain}.vetra.io` : null;
  const showDomain = domainToCheck;

  return (
    <section>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">
        Domain Configuration
      </h2>

      <div className="space-y-4">
        {/* System domain */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-[140px_1fr] items-center gap-y-4">
            <span className="text-sm font-medium text-gray-500">
              System Domain:
            </span>
            {systemDomain ? (
              <span className="font-mono text-sm text-gray-800">
                {systemDomain}
              </span>
            ) : (
              <span className="text-sm italic text-gray-400">
                Generating...
              </span>
            )}
          </div>
        </div>

        {/* Custom domain */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-[140px_1fr] items-center gap-y-4">
            <span className="text-sm font-medium text-gray-500">
              Custom Domain:
            </span>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <TextInput
                  value={localDomain}
                  onChange={(e) => setLocalDomain(e.target.value)}
                  onBlur={commitDomain}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. app.acme.com"
                />
              </div>
              {showDomain && (
                <span className="shrink-0">
                  {checking ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                      Checking...
                    </span>
                  ) : verified ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
                      Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
                      Not configured
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* DNS instructions - shown when domain is committed but not verified */}
          {showDomain && !verified && !checking && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800">
                Configure your DNS records
              </p>
              <p className="mb-3 text-xs text-amber-700">
                Point your domain to our load balancer by adding these DNS
                records:
              </p>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center gap-2 rounded bg-white px-3 py-2 text-gray-700">
                  <span className="w-12 font-semibold text-amber-800">A</span>
                  <span className="flex-1 text-gray-500">{showDomain}</span>
                  <span>{LB_CONFIG.ipv4}</span>
                </div>
                <div className="flex items-center gap-2 rounded bg-white px-3 py-2 text-gray-700">
                  <span className="w-12 font-semibold text-amber-800">
                    AAAA
                  </span>
                  <span className="flex-1 text-gray-500">{showDomain}</span>
                  <span>{LB_CONFIG.ipv6}</span>
                </div>
              </div>
              <p className="mt-3 text-xs text-amber-600">
                DNS changes may take up to 48 hours to propagate. We check every
                30 seconds.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
