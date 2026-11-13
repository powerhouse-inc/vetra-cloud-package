import { createHash } from "node:crypto";
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

/**
 * What Vetra also sets on shared instances while the licence gate is on
 * (releases phase 3 slice 5; gate/service.ts GATE_*). Shown read-only.
 */
export const VETRA_SHARED_SETTINGS: VetraSetting[] = [
  {
    name: "ACCESS",
    secret: false,
    value: "licensed (shared instances only)",
  },
  {
    name: "VETRA_APP_ID",
    secret: false,
    value: "the App's id (shared instances only)",
  },
  {
    name: "VETRA_GATE_URL",
    secret: false,
    value: "Vetra's licence check URL (shared instances only)",
  },
  {
    name: "VETRA_GATE_TOKEN",
    secret: true,
    value:
      "the instance's licence gate token, kept in OpenBao (shared instances only)",
  },
];

/**
 * Settings a host reads to open or loosen the licence gate of a shared
 * instance (releases phase 3 slice 5). Never set by a publisher or holder
 * setting, whatever the instance: ACCESS itself, the grace a host gives when
 * Vetra is down, the paths exempt from authentication, and auth itself.
 * ADMINS (always in) is a Vetra setting already; VETRA_GATE_* fall under the
 * VETRA_ prefix.
 */
export const GATE_LOOSENING_NAMES: readonly string[] = [
  "ACCESS",
  "ACCESS_GATE_GRACE_MS",
  "REQUIRE_AUTHENTICATED_CALLER_EXEMPT_PATHS",
  "AUTH_ENABLED",
];

/** Set by the processor or the chart, or guarding the licence gate (GATE_LOOSENING_NAMES): refused, not listed as set. */
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
  ...GATE_LOOSENING_NAMES,
];

export const RESERVED_SETTING_NAMES: ReadonlySet<string> = new Set([
  ...VETRA_SETTINGS.map((s) => s.name),
  ...ALSO_RESERVED,
]);
/**
 * Names Vetra writes on plan instances (AI key; the VETRA_ ones are reserved
 * by prefix): refused for holders, always, so a holder can never shadow them.
 */
export const HOLDER_RESERVED_NAMES: readonly string[] = ["OPENROUTER_API_KEY"];

export const RESERVED_PREFIXES: readonly string[] = [
  "VETRA_",
  "NODE_",
  "PG",
  "FILE_",
];

/** Plain FUSION env entry listing an instance's file mounts: JSON [{key, mountPath}] (the processor turns it into secretFiles). */
export const VETRA_FILES_ENV = "VETRA_FILES";
/** File settings per scope layer (publisher scope, or a holder's instance). */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 65536;
const MAX_MOUNT_PATH = 512;
const FORBIDDEN_ROOTS = [
  "/data",
  "/app",
  "/proc",
  "/sys",
  "/etc",
  "/var",
  "/dev",
  "/run",
  "/tmp",
  "/usr",
  "/bin",
  "/lib",
  "/root",
  "/home",
  "/opt",
];

/**
 * Whether the chart mounts secret files (powerhouse-chart E1 deployed and
 * FUSION_SECRET_FILES=on, read the same way as the gitops processor).
 */
export const secretFilesSupported = (env: NodeJS.ProcessEnv = process.env) =>
  ["on", "true", "1", "yes"].includes(
    (env.FUSION_SECRET_FILES ?? "").trim().toLowerCase(),
  );

/** Tenant secret key of a file: FILE_<16 hex of sha256(mountPath)>. */
export const fileKey = (mountPath: string) =>
  `FILE_${createHash("sha256").update(mountPath).digest("hex").slice(0, 16).toUpperCase()}`;

/** Absolute, normalised (no //, ., ..), at most 512 characters of [A-Za-z0-9._/-], not "/" and not under a system directory. */
export function checkMountPath(p: string): void {
  if (!secretFilesSupported())
    throw new SettingInputError(
      "Files are not supported yet: this Vetra deployment does not mount secret files",
    );
  if (!p.startsWith("/") || p === "/" || p.endsWith("/"))
    throw new SettingInputError(
      "A mount path is an absolute file path, such as /client_secret.json",
    );
  if (p.length > MAX_MOUNT_PATH || !/^[A-Za-z0-9._/-]+$/.test(p))
    throw new SettingInputError(
      `A mount path has at most ${MAX_MOUNT_PATH} letters, digits, ".", "_", "-" and "/"`,
    );
  if (
    p
      .split("/")
      .slice(1)
      .some((seg) => seg === "" || seg === "." || seg === "..")
  )
    throw new SettingInputError(
      "A mount path cannot contain //, /./ or /../",
    );
  const root = FORBIDDEN_ROOTS.find((r) => p === r || p.startsWith(`${r}/`));
  if (root)
    throw new SettingInputError(`Files cannot be mounted under ${root}`);
}

/** Never echoes the content. */
export function checkFileValue(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0) throw new SettingInputError("The file is empty");
  if (bytes > MAX_FILE_BYTES)
    throw new SettingInputError("A file is at most 64 KiB");
}

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
