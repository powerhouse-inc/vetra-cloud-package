import { describe, expect, it } from "vitest";
import {
  checkSettingName,
  checkSettingValue,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
} from "../settings/names.js";
import { settingsForKind, settingsRevision } from "../settings/resolve.js";
import type { AppSettingRow } from "../settings/repo.js";
import {
  createSettingsVault,
  APP_SETTINGS_TRANSIT_TENANT,
} from "../settings/vault.js";

const row = (o: Partial<AppSettingRow>): AppSettingRow => ({
  app_id: "app-1",
  scope: "all",
  name: "FOO",
  secret: false,
  value: "1",
  ciphertext: null,
  write_id: "w1",
  updated_at: "2026-11-12T00:00:00.000Z",
  updated_by: "0xaa",
  ...o,
});

describe("setting names", () => {
  it.each([
    "PH_HOST",
    "ADMINS",
    "PUBLIC_URL",
    "PH_SWITCHBOARD_DATABASE_URL",
    "PH_WORKFLOWS_SECRETS_MASTER_KEY",
    "PH_ATTACHMENT_URL_SIGNING_SECRET",
    "PH_HOST_PORT",
    "PGPASSWORD",
    "VETRA_SETTINGS_REVISION",
    "VETRA_ANYTHING",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_PATH",
    "PGSSLMODE",
    "PGOPTIONS",
    "PGSERVICE",
    "PGHOST",
  ])("refuses %s (Vetra sets it)", (name) => {
    expect(() => checkSettingName(name)).toThrow(SettingInputError);
  });

  it.each([
    "lower",
    "ph_host",
    "PH_HOST ",
    "FOO\n",
    "1ABC",
    "A-B",
    "",
    "A".repeat(129),
  ])("refuses the malformed name %j", (name) => {
    expect(() => checkSettingName(name)).toThrow(SettingInputError);
  });

  it("accepts a publisher name, including OPENROUTER_API_KEY on dev instances", () => {
    expect(() => checkSettingName("SEKTAR_OAUTH_RELAY_BASE")).not.toThrow();
    expect(() => checkSettingName("OPENROUTER_API_KEY")).not.toThrow();
  });

  it("lists every Vetra setting as reserved", () => {
    for (const s of VETRA_SETTINGS)
      expect(RESERVED_SETTING_NAMES.has(s.name)).toBe(true);
  });

  it("checks values: secrets non-empty and not NEXT_PUBLIC_, sizes bounded", () => {
    expect(() => checkSettingValue("FOO", "", false)).not.toThrow();
    expect(() => checkSettingValue("FOO", "", true)).toThrow(SettingInputError);
    expect(() => checkSettingValue("NEXT_PUBLIC_X", "v", true)).toThrow(
      SettingInputError,
    );
    expect(() => checkSettingValue("FOO", "x".repeat(4097), false)).toThrow(
      SettingInputError,
    );
    expect(() => checkSettingValue("FOO", "x".repeat(65537), true)).toThrow(
      SettingInputError,
    );
    expect(() =>
      checkSettingValue("FOO", "x".repeat(65536), true),
    ).not.toThrow();
  });
});

describe("settingsForKind", () => {
  it("lets a kind's own setting win over ALL and keeps the others", () => {
    const rows = [
      row({ name: "A", value: "all" }),
      row({ name: "A", scope: "preview", value: "preview" }),
      row({ name: "B", value: "b" }),
      row({ name: "C", scope: "branch", value: "branch only" }),
    ];
    expect(settingsForKind(rows, "preview").plain).toEqual([
      { name: "A", value: "preview" },
      { name: "B", value: "b" },
    ]);
    expect(settingsForKind(rows, "branch").plain).toEqual([
      { name: "A", value: "all" },
      { name: "B", value: "b" },
      { name: "C", value: "branch only" },
    ]);
  });

  it("separates secrets (ciphertext and write id only)", () => {
    const s = settingsForKind(
      [
        row({
          name: "S",
          secret: true,
          value: null,
          ciphertext: "ct",
          write_id: "w9",
        }),
      ],
      "branch",
    );
    expect(s.plain).toEqual([]);
    expect(s.secrets).toEqual([{ name: "S", ciphertext: "ct", writeId: "w9" }]);
  });

  it("a kind-scoped plain setting replaces an ALL secret of the same name", () => {
    const s = settingsForKind(
      [
        row({ name: "S", secret: true, value: null, ciphertext: "ct" }),
        row({ name: "S", scope: "preview", value: "plain" }),
      ],
      "preview",
    );
    expect(s.secrets).toEqual([]);
    expect(s.plain).toEqual([{ name: "S", value: "plain" }]);
  });

  it("shared and own kinds get ALL only (phase 3 adds per-template settings)", () => {
    const rows = [row({ name: "A" }), row({ name: "B", scope: "branch" })];
    expect(settingsForKind(rows, "shared").plain.map((p) => p.name)).toEqual([
      "A",
    ]);
  });

  it("has a stable 16-hex revision that follows values and secret writes", () => {
    const base = settingsForKind([row({})], "branch").revision;
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(settingsForKind([row({})], "branch").revision).toBe(base);
    expect(settingsForKind([row({ value: "2" })], "branch").revision).not.toBe(
      base,
    );
    const sec = (w: string) =>
      settingsForKind(
        [row({ secret: true, value: null, ciphertext: "x", write_id: w })],
        "branch",
      ).revision;
    expect(sec("w1")).not.toBe(sec("w2"));
    expect(settingsRevision([], [])).toBe(
      settingsForKind([], "preview").revision,
    );
  });
});

describe("createSettingsVault", () => {
  it("is null without OpenBao and uses the app-settings transit key otherwise", async () => {
    expect(createSettingsVault(null)).toBeNull();
    const calls: string[] = [];
    const vault = createSettingsVault({
      ensureTenantKey: async (t) => void calls.push(`key:${t}`),
      encrypt: async (t, p) => (calls.push(`enc:${t}`), `ct(${p})`),
      decrypt: async (t, c) => (calls.push(`dec:${t}`), c.slice(3, -1)),
    })!;
    expect(await vault.decrypt(await vault.encrypt("s3cret"))).toBe("s3cret");
    expect(calls).toEqual([
      `key:${APP_SETTINGS_TRANSIT_TENANT}`,
      `enc:${APP_SETTINGS_TRANSIT_TENANT}`,
      `dec:${APP_SETTINGS_TRANSIT_TENANT}`,
    ]);
  });
});
