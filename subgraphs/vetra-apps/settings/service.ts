import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import type { AppSettingScope } from "../db/schema.js";
import { gateConfigOf } from "../config.js";
import { appsError, notConfigured } from "../errors.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  checkSettingName,
  checkSettingValue,
  MAX_SETTINGS_PER_APP,
  RESERVED_PREFIXES,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
  VETRA_SHARED_SETTINGS,
  type VetraSetting,
} from "./names.js";
import {
  deleteAppSetting as deleteRow,
  listAppSettings,
  upsertAppSetting,
  type AppSettingRow,
} from "./repo.js";

export type AppSettingScopeName = "ALL" | "BRANCH" | "PREVIEW";
const TO_SCOPE: Record<AppSettingScopeName, AppSettingScope> = {
  ALL: "all",
  BRANCH: "branch",
  PREVIEW: "preview",
};
const FROM_SCOPE: Record<AppSettingScope, AppSettingScopeName> = {
  all: "ALL",
  branch: "BRANCH",
  preview: "PREVIEW",
};
const SCOPE_ORDER: Record<AppSettingScope, number> = {
  all: 0,
  branch: 1,
  preview: 2,
};

export interface AppSettingJson {
  name: string;
  scope: AppSettingScopeName;
  secret: boolean;
  /** Plain settings only; null for secrets (write-only). */
  value: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface AppSettingsJson {
  settings: AppSettingJson[];
  vetra: VetraSetting[];
  /** What Vetra also sets on shared instances (licence gate); empty while the gate is off. */
  vetraShared: VetraSetting[];
  reservedNames: string[];
  reservedPrefixes: string[];
}

export interface SetAppSettingInput {
  appId: string;
  name: string;
  value: string;
  secret: boolean;
  scope?: AppSettingScopeName | null;
}

const json = (r: AppSettingRow): AppSettingJson => ({
  name: r.name,
  scope: FROM_SCOPE[r.scope],
  secret: r.secret,
  value: r.secret ? null : r.value,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

function scopeOf(s: AppSettingScopeName | null | undefined): AppSettingScope {
  const scope = Object.hasOwn(TO_SCOPE, s ?? "ALL")
    ? TO_SCOPE[s ?? "ALL"]
    : undefined;
  if (!scope) throw appsError("BAD_USER_INPUT", `Unknown scope ${String(s)}`);
  return scope;
}

/**
 * The App's settings (spec 14.2) and the ones Vetra sets itself. Operators
 * and release managers only: plain values may be private. Secrets come back as
 * names and metadata.
 */
export async function appSettingsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppSettingsJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "release" });
  const rows = await listAppSettings(deps.db, app.id);
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope],
  );
  return {
    settings: rows.map(json),
    vetra: VETRA_SETTINGS,
    vetraShared: gateConfigOf(deps.cfg).enabled ? VETRA_SHARED_SETTINGS : [],
    reservedNames: [...RESERVED_SETTING_NAMES].sort(),
    reservedPrefixes: [...RESERVED_PREFIXES],
  };
}

/** Sets or replaces one setting; instances get it on the reconciler's next pass. */
export async function setAppSetting(
  deps: AppsDeps,
  caller: Caller,
  input: SetAppSettingInput,
): Promise<AppSettingJson> {
  const app = await loadAppForOwner(deps, caller, input.appId, {
    need: "release",
  });
  const scope = scopeOf(input.scope);
  try {
    checkSettingName(input.name);
    checkSettingValue(input.name, input.value, input.secret);
  } catch (err) {
    if (err instanceof SettingInputError)
      throw appsError("BAD_USER_INPUT", err.message);
    throw err;
  }
  let ciphertext: string | null = null;
  if (input.secret) {
    if (!deps.settingsVault)
      throw notConfigured("Secret settings (OPENBAO_ADDR)");
    try {
      ciphertext = await deps.settingsVault.encrypt(input.value);
    } catch (err) {
      // The detail (addresses, OpenBao's own message) stays in the log.
      deps.logger.warn(
        `[vetra-apps] encrypting setting ${input.name} of ${app.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw appsError("SERVICE_UNAVAILABLE", "Secret storage unavailable");
    }
  }
  const row: AppSettingRow = {
    app_id: app.id,
    scope,
    name: input.name,
    secret: input.secret,
    value: input.secret ? null : input.value,
    ciphertext,
    write_id: deps.newId(),
    updated_at: deps.now().toISOString(),
    updated_by: caller.address,
  };
  // Count and write under the App row's lock: concurrent writes never pass the cap together.
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("apps")
      .select("id")
      .where("id", "=", app.id)
      .forUpdate()
      .execute();
    const existing = await listAppSettings(trx, app.id);
    const replaces = existing.some(
      (r) => r.scope === scope && r.name === input.name,
    );
    if (!replaces && existing.length >= MAX_SETTINGS_PER_APP)
      throw appsError(
        "BAD_USER_INPUT",
        `An App has at most ${MAX_SETTINGS_PER_APP} settings; delete one first`,
      );
    await upsertAppSetting(trx, row);
    // Never the value: the audit log is readable by every viewer of the App.
    await auditCaller(trx, caller, {
      appId: app.id,
      at: row.updated_at,
      action: "setting.set",
      subject: `setting:${FROM_SCOPE[scope]}/${row.name}`,
      detail: {
        name: row.name,
        scope: FROM_SCOPE[scope],
        secret: row.secret,
        replaced: replaces,
      },
    });
  });
  // Names only: values never reach a log.
  deps.logger.info(
    `[vetra-apps] setting ${row.name} (${scope}${row.secret ? ", secret" : ""}) of ${app.slug} set by ${caller.address}`,
  );
  return json(row);
}

/** Deletes one setting (default scope ALL); instances roll without it. */
export async function deleteAppSetting(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  name: string,
  scope?: AppSettingScopeName | null,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "release" });
  const s = scopeOf(scope);
  const deleted = await deps.db.transaction().execute(async (trx) => {
    const gone = await deleteRow(trx, app.id, s, name);
    if (gone)
      await auditCaller(trx, caller, {
        appId: app.id,
        at: deps.now().toISOString(),
        action: "setting.deleted",
        subject: `setting:${FROM_SCOPE[s]}/${name}`,
        detail: { name, scope: FROM_SCOPE[s] },
      });
    return gone;
  });
  if (deleted)
    deps.logger.info(
      `[vetra-apps] setting ${name} (${s}) of ${app.slug} deleted by ${caller.address}`,
    );
  return deleted;
}
