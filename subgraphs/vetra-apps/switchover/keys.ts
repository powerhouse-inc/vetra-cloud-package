import { createHash } from "node:crypto";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { WORKFLOWS_MASTER_KEY } from "../../vetra-cloud-secrets/services/secrets-service.js";
import { ATTACHMENT_SIGNING_KEY } from "../settings/names.js";

/** The two files on an environment's /data the host keeps its keys in (docker-entrypoint kept_secret). */
export const MASTER_KEY_FILE = "workflows-master-key";
export const ATTACHMENT_KEY_FILE = "attachment-url-signing-secret";
export const KEY_FILES = [MASTER_KEY_FILE, ATTACHMENT_KEY_FILE];

export interface KeyFingerprints {
  master: string;
  attachment: string;
}
export interface KeyValues {
  master: string;
  attachment: string;
}

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;

/** The values of the two key files, or null when either is not a 64-character hex key (a trailing newline is ignored). */
export function parseKeyFiles(files: Map<string, Buffer>): KeyValues | null {
  const master = files.get(MASTER_KEY_FILE)?.toString("utf8").trim();
  const attachment = files.get(ATTACHMENT_KEY_FILE)?.toString("utf8").trim();
  if (!master || !attachment) return null;
  if (!HEX64.test(master) || !HEX64.test(attachment)) return null;
  return { master, attachment };
}

export const fingerprintsOf = (k: KeyValues): KeyFingerprints => ({
  master: sha256Hex(k.master),
  attachment: sha256Hex(k.attachment),
});

export function parseFingerprints(raw: string | null): KeyFingerprints | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<KeyFingerprints>;
    return typeof o.master === "string" && typeof o.attachment === "string"
      ? { master: o.master, attachment: o.attachment }
      : null;
  } catch {
    return null;
  }
}

/** The tenant secret keys under which each file's value lives in the new tenant. */
export const TENANT_KEYS = {
  master: WORKFLOWS_MASTER_KEY,
  attachment: ATTACHMENT_SIGNING_KEY,
} as const;

/** The tenant (namespace) an instance's environment gets: its generic subdomain (or host) and its id. */
export const tenantOfEnvironment = (
  state: { genericSubdomain?: string | null } | null,
  host: string,
  environmentId: string,
) => getTenantId(state?.genericSubdomain ?? host, environmentId);
