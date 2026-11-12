import { createHash } from "node:crypto";
import type { AppSettingScope, InstanceKind } from "../db/schema.js";
import type { AppSettingRow } from "./repo.js";

export interface ResolvedSecret {
  name: string;
  ciphertext: string;
  writeId: string;
}

/** An instance kind's settings: what its environment and its tenant get. */
export interface InstanceSettings {
  /** 16 hex; VETRA_SETTINGS_REVISION. */
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secrets: ResolvedSecret[];
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

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
 * The settings of one instance kind: its own scope wins over "all" by name.
 * - branch/preview: "all", then the kind's own scope.
 * - shared/own (plan instances, H1): "all" plain settings only, then "plan".
 *   Publisher secrets meant for customers' instances must be scoped PLAN.
 */
export function settingsForKind(
  rows: AppSettingRow[],
  kind: InstanceKind,
): InstanceSettings {
  const plan = kind === "shared" || kind === "own";
  const own: AppSettingScope = plan ? "plan" : kind;
  const chosen = new Map<string, AppSettingRow>();
  for (const r of rows)
    if (r.scope === "all" && !(plan && r.secret)) chosen.set(r.name, r);
  for (const r of rows) if (r.scope === own) chosen.set(r.name, r);
  const plain: InstanceSettings["plain"] = [];
  const secrets: ResolvedSecret[] = [];
  for (const r of chosen.values()) {
    if (r.secret) {
      if (r.ciphertext)
        secrets.push({
          name: r.name,
          ciphertext: r.ciphertext,
          writeId: r.write_id,
        });
    } else plain.push({ name: r.name, value: r.value ?? "" });
  }
  plain.sort(byName);
  secrets.sort(byName);
  return { revision: settingsRevision(plain, secrets), plain, secrets };
}
