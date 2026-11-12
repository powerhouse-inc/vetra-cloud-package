import {
  KEY_PATTERN,
  WORKFLOWS_MASTER_KEY,
} from "../../vetra-cloud-secrets/services/secrets-service.js";

/** Plain env on every instance: the App settings revision it runs (health compares it). */
export const SETTINGS_REVISION_ENV = "VETRA_SETTINGS_REVISION";
/** Signs attachment download links; generated once per instance like the master key. */
export const ATTACHMENT_SIGNING_KEY = "PH_ATTACHMENT_URL_SIGNING_SECRET";
/**
 * Secrets Vetra generates once per instance (tenant secrets store, ensureSecret:
 * never overwritten). A host with an ephemeral /data would otherwise generate
 * its own on every start, and the switchboard refuses a master key other than
 * the one its database first used.
 */
export const VETRA_GENERATED_SECRETS: readonly string[] = [
  WORKFLOWS_MASTER_KEY,
  ATTACHMENT_SIGNING_KEY,
];

export interface VetraSetting {
  name: string;
  secret: boolean;
  /** What Vetra sets: the value, or a description of a per-instance value. */
  value: string;
}

/** What Vetra sets on every branch and preview instance (spec section 5). Shown read-only. */
export const VETRA_SETTINGS: VetraSetting[] = [
  { name: "PH_HOST", secret: false, value: "the release's host (e.g. cli)" },
  { name: "ADMINS", secret: false, value: "the App's owner" },
  { name: "PUBLIC_URL", secret: false, value: "https://<instance host>" },
  {
    name: "PH_SWITCHBOARD_DATABASE_URL",
    secret: true,
    value: "the instance's own Postgres database",
  },
  {
    name: "PH_REACTOR_DATABASE_URL",
    secret: true,
    value: "the instance's own Postgres database",
  },
  {
    name: "DATABASE_URL",
    secret: true,
    value: "the instance's own Postgres database",
  },
  {
    name: "LISTEN_DATABASE_URL",
    secret: true,
    value: "the instance's own Postgres database (direct, for LISTEN)",
  },
  {
    name: WORKFLOWS_MASTER_KEY,
    secret: true,
    value: "generated once per instance, kept in OpenBao",
  },
  {
    name: ATTACHMENT_SIGNING_KEY,
    secret: true,
    value: "generated once per instance, kept in OpenBao",
  },
  { name: "NODE_ENV", secret: false, value: "production" },
  {
    name: "NODE_OPTIONS",
    secret: false,
    value: "a heap sized to the instance",
  },
  {
    name: SETTINGS_REVISION_ENV,
    secret: false,
    value: "the revision of this App's settings the instance runs",
  },
];

/** Set by the processor or the chart, or planned (ACCESS, phase 3): refused, not listed as set. */
const ALSO_RESERVED = [
  "PH_HOST_PORT",
  "PH_USER_DATA_DIR",
  "PORT",
  "HOSTNAME",
  "PH_CONNECT_CONFIG_JSON",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGHOST",
  "PGPORT",
  "SENTRY_DSN",
  "SENTRY_ENV",
  "OPENPANEL_CLIENT_ID",
  "OPENPANEL_API_URL",
  "OPENPANEL_ENV",
  "ACCESS",
];

export const RESERVED_SETTING_NAMES: ReadonlySet<string> = new Set([
  ...VETRA_SETTINGS.map((s) => s.name),
  ...ALSO_RESERVED,
]);
export const RESERVED_PREFIXES: readonly string[] = ["VETRA_", "NODE_", "PG"];

export const MAX_SETTINGS_PER_APP = 100;
const MAX_NAME_LENGTH = 128;
const MAX_PLAIN_BYTES = 4096;
const MAX_SECRET_BYTES = 65536;

export class SettingInputError extends Error {
  override name = "SettingInputError";
}

export function checkSettingName(name: string): void {
  if (!KEY_PATTERN.test(name) || name.length > MAX_NAME_LENGTH)
    throw new SettingInputError(
      `"${name.slice(0, 40)}" is not a setting name: use capitals, digits and _ (starting with a capital, at most ${MAX_NAME_LENGTH} characters)`,
    );
  if (
    RESERVED_SETTING_NAMES.has(name) ||
    RESERVED_PREFIXES.some((p) => name.startsWith(p))
  )
    throw new SettingInputError(`"${name}" is set by Vetra; it cannot be set`);
}

/** Never echoes the value. */
export function checkSettingValue(
  name: string,
  value: string,
  secret: boolean,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (secret) {
    if (name.startsWith("NEXT_PUBLIC_"))
      throw new SettingInputError(
        `"${name}" cannot be a secret: NEXT_PUBLIC_ values are inlined into browser JavaScript`,
      );
    if (bytes === 0)
      throw new SettingInputError(`The secret "${name}" is empty`);
    if (bytes > MAX_SECRET_BYTES)
      throw new SettingInputError(`The secret "${name}" is larger than 64 KiB`);
  } else if (bytes > MAX_PLAIN_BYTES)
    throw new SettingInputError(
      `"${name}" is larger than 4 KiB; store large values as a secret`,
    );
}
