/**
 * Legacy shapes the startup migration reads. Declared here, not imported, so
 * the migration keeps compiling after the code that wrote them is deleted
 * (vetra-access-codes, the app-license-type model).
 */

/** Rows of the vetra-access-codes namespace (read-only), as that subgraph wrote them. */
export interface LegacyAccessDB {
  invite_codes: {
    code: string;
    label: string | null;
    active: boolean;
    expires_at: string | null;
    max_uses: number | null;
    created_at: string;
    anthropic_key_ciphertext: string | null;
  };
  invite_redemptions: {
    code: string;
    /** As the caller's bearer spelled it: did:pkh:<network>:<chain>:<address>. */
    user_did: string;
    redeemed_at: string;
    /** VARCHAR: written as ISO by vetra-access-codes, but never trusted to parse. */
    access_expires: string | null;
  };
}

/**
 * A stored timestamp as canonical ISO, or null when it does not parse.
 * Legacy columns are VARCHAR, so nothing guarantees their shape.
 */
export function isoInstant(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
