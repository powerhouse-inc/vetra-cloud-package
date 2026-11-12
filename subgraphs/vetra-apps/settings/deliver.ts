import { randomBytes } from "node:crypto";
import { notConfigured } from "../errors.js";
import type { AppsDeps } from "../service.js";
import { VETRA_GENERATED_SECRETS } from "./names.js";
import type { InstanceSettings } from "./resolve.js";

/**
 * Writes an instance's secrets to its tenant (spec 5 and 14.2): Vetra's
 * generated keys once (never replaced), the publisher's secrets in one batch,
 * secrets the environment declared but no longer wants deleted, then a notify
 * so the controller materializes <tenant>-secrets now (its namespace may only
 * now exist). Values exist in plaintext only in this call.
 */
export async function deliverSettings(
  deps: AppsDeps,
  tenantId: string,
  settings: InstanceSettings,
  declared: string[],
): Promise<void> {
  const secrets = deps.instanceSecrets;
  if (!secrets) throw notConfigured("The tenant secrets store (OPENBAO_ADDR)");
  for (const key of VETRA_GENERATED_SECRETS)
    await secrets.ensureSecret(tenantId, key, () =>
      randomBytes(32).toString("hex"),
    );
  if (settings.secrets.length > 0) {
    const vault = deps.settingsVault;
    if (!vault) throw notConfigured("Secret settings (OPENBAO_ADDR)");
    const entries = await Promise.all(
      settings.secrets.map(async (s) => ({
        key: s.name,
        value: await vault.decrypt(s.ciphertext),
      })),
    );
    await secrets.setSecrets(tenantId, entries);
  }
  const wanted = new Set([
    ...VETRA_GENERATED_SECRETS,
    ...settings.secrets.map((s) => s.name),
  ]);
  for (const name of declared)
    if (!wanted.has(name)) await secrets.deleteSecret(tenantId, name);
  await secrets.notifyTenant(tenantId);
}
