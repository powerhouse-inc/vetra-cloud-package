/** Values that must never reach a log line or a client, even inside an error message. */
export const SECRET_PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9_-]+/g, // OpenRouter keys
  /sk-ant-[A-Za-z0-9_-]+/g, // Claude keys (legacy, until phase 3)
  /vault:v\d+:[A-Za-z0-9+/=]+/g, // OpenBao transit ciphertexts
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, // credentials
];

/** Replace every secret in `text` with "[redacted]" and cap it at 1000 chars. */
export function redactSecrets(text: string, extra: RegExp[] = []): string {
  return [...SECRET_PATTERNS, ...extra]
    .reduce((t, re) => t.replace(re, "[redacted]"), text)
    .slice(0, 1000);
}
