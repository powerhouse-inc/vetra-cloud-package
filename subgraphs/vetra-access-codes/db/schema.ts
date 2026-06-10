export interface InviteCodes {
  code: string;
  label: string | null;
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  created_at: string;
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
