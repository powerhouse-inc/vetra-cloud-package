import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";

/**
 * The OpenBao transit pseudo-tenant publisher secrets are encrypted under
 * (transit key `<OPENBAO_TRANSIT_KEY_PREFIX>app-settings`), as licensing keeps
 * invite-code keys under `access-codes` (vetra-licensing/key-vault.ts).
 */
export const APP_SETTINGS_TRANSIT_TENANT = "app-settings";

export interface SettingsVault {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** Null without a transit client (OPENBAO_ADDR unset): secret settings are refused. */
export function createSettingsVault(
  transit: Pick<
    OpenBaoTransitClient,
    "ensureTenantKey" | "encrypt" | "decrypt"
  > | null,
): SettingsVault | null {
  if (!transit) return null;
  return {
    async encrypt(plaintext) {
      await transit.ensureTenantKey(APP_SETTINGS_TRANSIT_TENANT);
      return transit.encrypt(APP_SETTINGS_TRANSIT_TENANT, plaintext);
    },
    decrypt: (ciphertext) =>
      transit.decrypt(APP_SETTINGS_TRANSIT_TENANT, ciphertext),
  };
}
