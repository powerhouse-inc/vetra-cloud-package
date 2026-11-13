import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import type { AppSettingScope } from "../db/schema.js";
import { appsError, notConfigured } from "../errors.js";
import { AI_KEY_SECRET } from "../instances/vetra-secrets.js";
import { listPlans } from "../plans/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  checkFileValue,
  checkMountPath,
  checkSettingName,
  checkSettingValue,
  fileKey,
  MAX_FILES,
  MAX_SETTINGS_PER_APP,
  RESERVED_PREFIXES,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
  type VetraSetting,
} from "./names.js";
import {
  deleteAppSetting as deleteRow,
  listAppSettings,
  upsertAppSetting,
  type AppSettingRow,
} from "./repo.js";

export type AppSettingScopeName = "ALL" | "BRANCH" | "PREVIEW" | "PLAN";
const TO_SCOPE: Record<AppSettingScopeName, AppSettingScope> = {
  ALL: "all",
  BRANCH: "branch",
  PREVIEW: "preview",
  PLAN: "plan",
};
const FROM_SCOPE: Record<AppSettingScope, AppSettingScopeName> = {
  all: "ALL",
  branch: "BRANCH",
  preview: "PREVIEW",
  plan: "PLAN",
};
const SCOPE_ORDER: Record<AppSettingScope, number> = {
  all: 0,
  branch: 1,
  preview: 2,
  plan: 3,
};

export interface AppSettingJson {
  name: string;
  scope: AppSettingScopeName;
  secret: boolean;
  /** Plain settings only; null for secrets (write-only). */
  value: string | null;
  /** Files only: where the file is mounted (its name is derived). */
  mountPath: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface AppSettingsJson {
  settings: AppSettingJson[];
  vetra: VetraSetting[];
  reservedNames: string[];
  reservedPrefixes: string[];
}

export interface SetAppSettingInput {
  appId: string;
  /** Derived for files (FILE_<16 hex>); required otherwise. */
  name?: string | null;
  value: string;
  secret: boolean;
  scope?: AppSettingScopeName | null;
  /** A file (H6): mounted at this absolute path from a tenant secret; always secret. */
  mountPath?: string | null;
}

const json = (r: AppSettingRow): AppSettingJson => ({
  name: r.name,
  scope: FROM_SCOPE[r.scope],
  secret: r.secret,
  value: r.secret ? null : r.value,
  mountPath: r.mount_path ?? null,
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
 * Names Vetra sets itself on the App's plan instances, so refused in scope
 * PLAN: OPENROUTER_API_KEY while a plan has an AI budget (H7, Task 10 adds
 * the budget). None yet.
 */
export async function planReservedNames(
  deps: AppsDeps,
  appId: string,
): Promise<string[]> {
  // H7: the AI key is Vetra's while an active plan of the App has a budget.
  const budgeted = (await listPlans(deps.db, appId)).some(
    (p) => p.status === "active" && (p.ai_budget_usd ?? 0) > 0,
  );
  return budgeted ? [AI_KEY_SECRET] : [];
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
  const mountPath = input.mountPath ?? null;
  const isFile = mountPath !== null;
  // A file's name is derived from its path; it is always secret.
  let name = input.name ?? "";
  const secret = isFile || input.secret;
  try {
    if (isFile) {
      checkMountPath(mountPath);
      checkFileValue(input.value);
      name = fileKey(mountPath);
    } else {
      checkSettingName(name);
      checkSettingValue(name, input.value, secret);
    }
  } catch (err) {
    if (err instanceof SettingInputError)
      throw appsError("BAD_USER_INPUT", err.message);
    throw err;
  }
  if (
    scope === "plan" &&
    (await planReservedNames(deps, app.id)).includes(name)
  )
    throw appsError(
      "BAD_USER_INPUT",
      `"${name}" is set by Vetra on this App's plan instances`,
    );
  let ciphertext: string | null = null;
  if (secret) {
    if (!deps.settingsVault)
      throw notConfigured("Secret settings (OPENBAO_ADDR)");
    try {
      ciphertext = await deps.settingsVault.encrypt(input.value);
    } catch (err) {
      // The detail (addresses, OpenBao's own message) stays in the log.
      deps.logger.warn(
        `[vetra-apps] encrypting setting ${name} of ${app.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw appsError("SERVICE_UNAVAILABLE", "Secret storage unavailable");
    }
  }
  const row: AppSettingRow = {
    app_id: app.id,
    scope,
    name,
    secret,
    value: secret ? null : input.value,
    ciphertext,
    mount_path: mountPath,
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
      (r) => r.scope === scope && r.name === name,
    );
    if (
      isFile &&
      !replaces &&
      existing.filter((r) => r.scope === scope && r.mount_path).length >=
        MAX_FILES
    )
      throw appsError(
        "BAD_USER_INPUT",
        `A scope has at most ${MAX_FILES} files; delete one first`,
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
        ...(isFile ? { file: true } : {}),
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
