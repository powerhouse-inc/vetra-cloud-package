import { describe, expect, it } from "vitest";
import {
  checkMountPath,
  fileKey,
  checkSettingName,
  checkSettingValue,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
} from "../settings/names.js";
import {
  settingsForInstance,
  settingsForKind,
  settingsRevision,
} from "../settings/resolve.js";
import type { InstanceSettingRow } from "../settings/holder-repo.js";
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

describe("file mount paths (plan 7 Task 9)", () => {
  it.each(["/client_secret_sektar-web-app.json", "/config/oauth/client.json"])(
    "accepts %s",
    (p) => expect(() => checkMountPath(p)).not.toThrow(),
  );
  it.each([
    "/data/x",
    "/data",
    "/etc/passwd",
    "/tmp/a",
    "relative",
    "/a/../etc/passwd",
    "/a/./b",
    "//a",
    "/",
    "/a/",
    "/a b",
    `/${"a".repeat(512)}`,
  ])("refuses %s", (p) =>
    expect(() => checkMountPath(p)).toThrow(SettingInputError),
  );
  it("derives the tenant secret key from the path", () => {
    expect(fileKey("/client_secret_sektar-web-app.json")).toMatch(
      /^FILE_[0-9A-F]{16}$/,
    );
    expect(fileKey("/a.json")).toBe(fileKey("/a.json"));
    expect(fileKey("/a.json")).not.toBe(fileKey("/b.json"));
    expect(() => checkSettingName(fileKey("/a.json"))).toThrow(
      SettingInputError,
    );
  });
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

  it("shared and own kinds ignore branch-scoped settings", () => {
    const rows = [row({ name: "A" }), row({ name: "B", scope: "branch" })];
    expect(settingsForKind(rows, "shared").plain.map((p) => p.name)).toEqual([
      "A",
    ]);
  });

  it("plan instances get ALL plain settings only, never ALL secrets (H1)", () => {
    const rows = [
      row({ name: "TOKEN", secret: true, value: null, ciphertext: "ct" }),
      row({ name: "MODE", value: "a" }),
    ];
    for (const kind of ["own", "shared"] as const) {
      const s = settingsForKind(rows, kind);
      expect(s.plain).toEqual([{ name: "MODE", value: "a" }]);
      expect(s.secrets).toEqual([]);
    }
  });

  it("plan instances get PLAN settings, secrets included; PLAN wins over ALL", () => {
    const rows = [
      row({ name: "MODE", value: "a" }),
      row({ name: "MODE", scope: "plan", value: "b" }),
      row({
        name: "TOKEN",
        scope: "plan",
        secret: true,
        value: null,
        ciphertext: "ct",
        write_id: "w7",
      }),
    ];
    for (const kind of ["own", "shared"] as const) {
      const s = settingsForKind(rows, kind);
      expect(s.plain).toEqual([{ name: "MODE", value: "b" }]);
      expect(s.secrets).toEqual([
        { name: "TOKEN", ciphertext: "ct", writeId: "w7" },
      ]);
    }
  });

  it("branch and preview keep ALL secrets and ignore PLAN rows", () => {
    const base = [
      row({ name: "TOKEN", secret: true, value: null, ciphertext: "ct" }),
      row({ name: "MODE", value: "a" }),
    ];
    const withPlan = [
      ...base,
      row({ name: "MODE", scope: "plan", value: "b" }),
      row({ name: "ONLY_PLAN", scope: "plan", value: "x" }),
    ];
    for (const kind of ["branch", "preview"] as const) {
      const s = settingsForKind(withPlan, kind);
      expect(s.plain).toEqual([{ name: "MODE", value: "a" }]);
      expect(s.secrets.map((x) => x.name)).toEqual(["TOKEN"]);
      expect(s.revision).toBe(settingsForKind(base, kind).revision);
    }
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

const hrow = (o: Partial<InstanceSettingRow>): InstanceSettingRow => ({
  instance_id: "i1",
  name: "MODE",
  kind: "plain",
  mount_path: null,
  value: "h",
  ciphertext: null,
  write_id: "hw1",
  updated_at: "2026-11-12T00:00:00.000Z",
  updated_by: "0xbb",
  ...o,
});

describe("settingsForInstance", () => {
  it("a holder plain setting wins over a PLAN one of the same name (H2)", () => {
    const s = settingsForInstance(
      [row({ name: "MODE", scope: "plan", value: "p" })],
      [hrow({ value: "h" })],
      "own",
    );
    expect(s.plain).toEqual([{ name: "MODE", value: "h" }]);
    expect(s.holderCount).toBe(1);
  });

  it("a holder secret replaces a publisher plain of the same name: one entry, a secret, decrypted by the holder vault", () => {
    const s = settingsForInstance(
      [row({ name: "CLIENT", scope: "plan", value: "pub" })],
      [
        hrow({
          name: "CLIENT",
          kind: "secret",
          value: null,
          ciphertext: "hct",
          write_id: "hw2",
        }),
      ],
      "own",
    );
    expect(s.plain).toEqual([]);
    expect(s.secrets).toEqual([
      { name: "CLIENT", ciphertext: "hct", writeId: "hw2", vault: "holder" },
    ]);
  });

  it("a holder plain replaces a publisher secret of the same name", () => {
    const s = settingsForInstance(
      [
        row({
          name: "CLIENT",
          scope: "plan",
          secret: true,
          value: null,
          ciphertext: "ct",
        }),
      ],
      [hrow({ name: "CLIENT", value: "mine" })],
      "own",
    );
    expect(s.secrets).toEqual([]);
    expect(s.plain).toEqual([{ name: "CLIENT", value: "mine" }]);
  });

  it("ignores holder rows for shared, branch and preview instances", () => {
    const app = [row({ name: "MODE", value: "a" })];
    for (const kind of ["shared", "branch", "preview"] as const) {
      const s = settingsForInstance(app, [hrow({ value: "h" })], kind);
      expect(s.plain).toEqual([{ name: "MODE", value: "a" }]);
      expect(s.holderCount).toBe(0);
      expect(s.revision).toBe(settingsForKind(app, kind).revision);
    }
  });

  it("golden: branch and preview revisions are the literal v1 hashes they were before plan 7 (no mass roll)", () => {
    const rows = [
      row({ name: "FOO", value: "1" }),
      row({ scope: "branch", name: "MODE", value: "x" }),
      row({
        name: "TOKEN",
        secret: true,
        value: null,
        ciphertext: "ct",
        write_id: "w7",
      }),
      row({ scope: "plan", name: "PLAN_ONLY", value: "p" }),
    ];
    expect(settingsForKind(rows, "branch").revision).toBe("4f4972ae967d1a9a");
    expect(settingsForInstance(rows, [], "branch").revision).toBe(
      "4f4972ae967d1a9a",
    );
    expect(settingsForKind([], "preview").revision).toBe("3f00030cb1de1d48");
    expect(settingsForInstance([], [], "preview").revision).toBe(
      "3f00030cb1de1d48",
    );
  });

  it("emits the v1 revision without holder rows, files or Vetra secrets (no mass roll)", () => {
    const app = [
      row({ name: "MODE", value: "a" }),
      row({ name: "S", secret: true, value: null, ciphertext: "ct" }),
    ];
    for (const kind of ["branch", "preview", "shared", "own"] as const) {
      const k = settingsForKind(app, kind);
      const s = settingsForInstance(app, [], kind);
      expect(s.revision).toBe(settingsRevision(k.plain, k.secrets));
      expect(s).toMatchObject({ files: [], vetraSecrets: [], holderCount: 0 });
    }
  });

  it("the revision follows a holder secret's write id and the Vetra secret names", () => {
    const sec = (w: string) =>
      settingsForInstance(
        [],
        [hrow({ kind: "secret", value: null, ciphertext: "c", write_id: w })],
        "own",
      ).revision;
    expect(sec("a")).toMatch(/^[0-9a-f]{16}$/);
    expect(sec("a")).toBe(sec("a"));
    expect(sec("a")).not.toBe(sec("b"));
    const base = settingsForInstance([], [], "own").revision;
    const withVetra = settingsForInstance([], [], "own", [
      "OPENROUTER_API_KEY",
    ]);
    expect(withVetra.vetraSecrets).toEqual(["OPENROUTER_API_KEY"]);
    expect(withVetra.revision).not.toBe(base);
    expect(
      settingsForInstance([], [], "own", ["B_KEY", "A_KEY"]).revision,
    ).toBe(settingsForInstance([], [], "own", ["A_KEY", "B_KEY"]).revision);
  });

  it("holder files are resolved by key and mount path", () => {
    const s = settingsForInstance(
      [],
      [
        hrow({
          name: "FILE_0123456789abcdef",
          kind: "file",
          mount_path: "/client_secret.json",
          value: null,
          ciphertext: "fct",
          write_id: "fw",
        }),
      ],
      "own",
    );
    expect(s.files).toEqual([
      {
        key: "FILE_0123456789abcdef",
        mountPath: "/client_secret.json",
        ciphertext: "fct",
        writeId: "fw",
        vault: "holder",
      },
    ]);
    expect(s.secrets).toEqual([]);
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
