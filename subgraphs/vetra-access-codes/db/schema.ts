export interface InviteCodes {
  code: string;
  label: string | null;
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  created_at: string;
  /**
   * The code's attached Anthropic (Claude) API key, encrypted at rest via
   * OpenBao transit, or null when no key is attached. Never exposed as
   * plaintext through GraphQL — only the derived `hasAnthropicKey` boolean is.
   */
  anthropic_key_ciphertext: string | null;
}

export interface InviteRedemptions {
  code: string;
  user_did: string;
  redeemed_at: string;
  access_expires: string | null;
}

export interface VetraAccessCodesDB {
  invite_codes: InviteCodes;
  invite_redemptions: InviteRedemptions;
}
