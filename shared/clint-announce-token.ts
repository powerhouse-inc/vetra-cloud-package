import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignInput = {
  documentId: string;
  prefix: string;
};

const SEPARATOR = '|';

function assertNoSeparator(input: SignInput): void {
  if (input.documentId.includes(SEPARATOR) || input.prefix.includes(SEPARATOR)) {
    throw new Error(
      `documentId or prefix must not contain the '${SEPARATOR}' separator`,
    );
  }
}

/**
 * Sign a CLINT announce token. Output is the base64url encoding of
 * HMAC-SHA256(secret, `${documentId}|${prefix}`). Always 43 characters
 * (32-byte HMAC-SHA256 output, base64url-encoded).
 */
export function signClintAnnounceToken(
  input: SignInput,
  secret: Buffer,
): string {
  assertNoSeparator(input);
  const payload = `${input.documentId}${SEPARATOR}${input.prefix}`;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Verify a presented CLINT announce token. Returns false on any
 * mismatch (wrong inputs, wrong secret, malformed token); never throws.
 * Comparison is constant-time for valid-length inputs.
 */
export function verifyClintAnnounceToken(
  presented: string,
  input: SignInput,
  secret: Buffer,
): boolean {
  let expected: string;
  try {
    expected = signClintAnnounceToken(input, secret);
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/**
 * Read the shared CLINT announce secret from `process.env.CLINT_ANNOUNCE_SECRET`,
 * decoding from base64. Throws on missing secret to fail-fast at boot —
 * silent fallback would hide a misconfigured ExternalSecret pipeline.
 */
export function loadClintAnnounceSecret(): Buffer {
  const raw = process.env.CLINT_ANNOUNCE_SECRET;
  if (!raw) {
    throw new Error(
      'CLINT_ANNOUNCE_SECRET env var is required for CLINT announce token signing/verification',
    );
  }
  return Buffer.from(raw, 'base64');
}
