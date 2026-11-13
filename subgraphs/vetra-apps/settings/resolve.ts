import { createHash } from "node:crypto";
import type { AppSettingScope, InstanceKind } from "../db/schema.js";
import type { InstanceSettingRow } from "./holder-repo.js";
import type { AppSettingRow } from "./repo.js";

/** Which vault decrypts a secret: the publisher's (`app-settings`) unless marked holder. */
export type SettingsVaultName = "app" | "holder";

export interface ResolvedSecret {
  name: string;
  ciphertext: string;
  writeId: string;
  /** Set to "holder" for a holder's secret (instance-settings transit key); absent: the App's. */
  vault?: SettingsVaultName;
}

/** A file setting: its tenant secret key and where the processor mounts it (Task 9). */
export interface ResolvedFile {
  key: string;
  mountPath: string;
  ciphertext: string;
  writeId: string;
  vault?: SettingsVaultName;
}

/** An instance's settings: what its environment and its tenant get. */
export interface InstanceSettings {
  /** 16 hex; VETRA_SETTINGS_REVISION. */
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secrets: ResolvedSecret[];
  /** Files: tenant secret key + mount path. */
  files: ResolvedFile[];
  /** Secret names Vetra writes by other paths (AI key, reporting token). Declared, never deleted. */
  vetraSecrets: string[];
  /** Holder settings in effect (a count only, for the publisher view, H2). */
  holderCount: number;
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const byKey = (a: ResolvedFile, b: ResolvedFile) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

export function settingsRevision(
  plain: InstanceSettings["plain"],
  secrets: ResolvedSecret[],
): string {
  const doc = JSON.stringify([
    "v1",
    [...plain].sort(byName).map((p) => [p.name, p.value]),
    [...secrets].sort(byName).map((s) => [s.name, s.writeId]),
  ]);
  return createHash("sha256").update(doc).digest("hex").slice(0, 16);
}

/**
 * The revision of every layer. Without holder rows, files or Vetra secrets it
 * is the v1 revision, so branch and preview instances keep theirs (no mass roll).
 */
function instanceRevision(s: Omit<InstanceSettings, "revision">): string {
  if (
    s.holderCount === 0 &&
    s.files.length === 0 &&
    s.vetraSecrets.length === 0
  )
    return settingsRevision(s.plain, s.secrets);
  const doc = JSON.stringify([
    "v2",
    [...s.plain].sort(byName).map((p) => [p.name, p.value]),
    [...s.secrets].sort(byName).map((x) => [x.name, x.writeId]),
    [...s.files].sort(byKey).map((f) => [f.key, f.mountPath, f.writeId]),
    [...s.vetraSecrets].sort(),
  ]);
  return createHash("sha256").update(doc).digest("hex").slice(0, 16);
}

/**
 * The settings of one instance kind: its own scope wins over "all" by name.
 * - branch/preview: "all", then the kind's own scope.
 * - shared/own (plan instances, H1): "all" plain settings only, then "plan".
 *   Publisher secrets meant for customers' instances must be scoped PLAN.
 */
export function settingsForKind(
  rows: AppSettingRow[],
  kind: InstanceKind,
): InstanceSettings {
  return settingsForInstance(rows, [], kind);
}

/**
 * The App's layers (as settingsForKind), then the holder's for own instances
 * (H2: the holder wins by name; a holder secret replaces a publisher plain
 * setting and the other way round). `vetraSecrets`: names Vetra writes to the
 * tenant by other paths.
 */
export function settingsForInstance(
  appRows: AppSettingRow[],
  holderRows: InstanceSettingRow[],
  kind: InstanceKind,
  vetraSecrets: string[] = [],
): InstanceSettings {
  const plan = kind === "shared" || kind === "own";
  const own: AppSettingScope = plan ? "plan" : kind;
  const chosen = new Map<string, AppSettingRow>();
  for (const r of appRows)
    if (r.scope === "all" && !(plan && r.secret)) chosen.set(r.name, r);
  for (const r of appRows) if (r.scope === own) chosen.set(r.name, r);

  const plain = new Map<string, string>();
  const secrets = new Map<string, ResolvedSecret>();
  // Files by mount path: the holder's replaces the publisher's (H2).
  const files = new Map<string, ResolvedFile>();
  for (const r of chosen.values()) {
    if (r.secret && r.mount_path) {
      if (r.ciphertext)
        files.set(r.mount_path, {
          key: r.name,
          mountPath: r.mount_path,
          ciphertext: r.ciphertext,
          writeId: r.write_id,
        });
      continue;
    }
    if (r.secret) {
      if (r.ciphertext)
        secrets.set(r.name, {
          name: r.name,
          ciphertext: r.ciphertext,
          writeId: r.write_id,
        });
    } else plain.set(r.name, r.value ?? "");
  }

  const holder = kind === "own" ? holderRows : [];
  for (const r of holder) {
    if (r.kind === "file") {
      if (r.ciphertext && r.mount_path)
        files.set(r.mount_path, {
          key: r.name,
          mountPath: r.mount_path,
          ciphertext: r.ciphertext,
          writeId: r.write_id,
          vault: "holder",
        });
      continue;
    }
    plain.delete(r.name);
    secrets.delete(r.name);
    if (r.kind === "secret") {
      if (r.ciphertext)
        secrets.set(r.name, {
          name: r.name,
          ciphertext: r.ciphertext,
          writeId: r.write_id,
          vault: "holder",
        });
    } else plain.set(r.name, r.value ?? "");
  }

  const layers: Omit<InstanceSettings, "revision"> = {
    plain: [...plain].map(([name, value]) => ({ name, value })).sort(byName),
    secrets: [...secrets.values()].sort(byName),
    files: [...files.values()].sort(byKey),
    vetraSecrets: [...new Set(vetraSecrets)].sort(),
    holderCount: holder.length,
  };
  return { revision: instanceRevision(layers), ...layers };
}
