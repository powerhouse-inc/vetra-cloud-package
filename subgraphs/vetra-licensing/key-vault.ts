import type { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";

/**
 * The OpenBao transit pseudo-tenant attached invite-code Claude keys are
 * encrypted under. Unchanged from vetra-access-codes
 * (ACCESS_CODES_TRANSIT_TENANT), so ciphertexts stored before the move still
 * decrypt.
 */
export const INVITE_KEY_TRANSIT_TENANT = "access-codes";

export class KeyStorageUnavailableError extends Error {
  override name = "KeyStorageUnavailableError";
  constructor() {
    super("attached keys cannot be stored: OPENBAO_ADDR is not configured");
  }
}

export interface KeyVault {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/**
 * Null without a transit client (OPENBAO_ADDR unset): attached keys are then
 * unavailable. The transit key is `<keyNamePrefix>access-codes`, so the client
 * must be built with the same OPENBAO_TRANSIT_KEY_PREFIX as vetra-access-codes.
 */
export function createKeyVault(
  transit: Pick<OpenBaoTransitClient, "ensureTenantKey" | "encrypt" | "decrypt"> | null,
): KeyVault | null {
  if (!transit) return null;
  return {
    async encrypt(plaintext) {
      await transit.ensureTenantKey(INVITE_KEY_TRANSIT_TENANT);
      return transit.encrypt(INVITE_KEY_TRANSIT_TENANT, plaintext);
    },
    decrypt: (ciphertext) => transit.decrypt(INVITE_KEY_TRANSIT_TENANT, ciphertext),
  };
}
