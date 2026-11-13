import type { Kysely } from "kysely";
import { auditCaller } from "../audit/service.js";
import { recordAudit } from "../audit/repo.js";
import type { Caller } from "../auth.js";
import type { InstanceSettingKind, VetraAppsDB } from "../db/schema.js";
import { appsError, notConfigured } from "../errors.js";
import {
  loadOwnInstance,
  loadOwnInstanceForHolder,
  type OwnInstance,
} from "../holders/access.js";
import type { AppsDeps } from "../service.js";
import {
  deleteInstanceSetting,
  listInstanceSettings,
  upsertInstanceSetting,
  type InstanceSettingRow,
} from "./holder-repo.js";
import {
  checkFileValue,
  checkMountPath,
  fileKey,
  MAX_FILES,
  checkSettingName,
  checkSettingValue,
  RESERVED_PREFIXES,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
  type VetraSetting,
} from "./names.js";
import { listAppSettings } from "./repo.js";
import { settingsForKind } from "./resolve.js";

/** Holder settings per own instance (plan 7 model). */
export const MAX_HOLDER_SETTINGS = 50;

export type HolderSettingKindName = "PLAIN" | "SECRET" | "FILE";
const TO_KIND: Record<HolderSettingKindName, InstanceSettingKind> = {
  PLAIN: "plain",
  SECRET: "secret",
  FILE: "file",
};
const FROM_KIND: Record<InstanceSettingKind, HolderSettingKindName> = {
  plain: "PLAIN",
  secret: "SECRET",
  file: "FILE",
};

export interface HolderSettingJson {
  name: string;
  kind: HolderSettingKindName;
  /** Plain settings only; null for secrets and files (write-only). */
  value: string | null;
  mountPath: string | null;
  updatedAt: string;
}

export interface HolderSettingsJson {
  settings: HolderSettingJson[];
  vetra: VetraSetting[];
  /** Names the App's publisher sets on this instance (H2: values never shown). */
  publisherNames: string[];
  reservedNames: string[];
  reservedPrefixes: string[];
}

export interface SetHolderSettingInput {
  instanceId: string;
  name?: string | null;
  kind: HolderSettingKindName;
  value: string;
  mountPath?: string | null;
}

export interface ImportedHolderSetting {
  name: string;
  kind: HolderSettingKindName;
  value: string;
  mountPath?: string | null;
}

export interface ImportHolderSettingsResult {
  stored: string[];
  skipped: Array<{ name: string; reason: string }>;
}

const json = (r: InstanceSettingRow): HolderSettingJson => ({
  name: r.name,
  kind: FROM_KIND[r.kind],
  value: r.kind === "plain" ? r.value : null,
  mountPath: r.mount_path,
  updatedAt: r.updated_at,
});

/** Validates a write and builds its row (secrets encrypted). Throws SettingInputError for bad input. */
async function prepareRow(
  deps: AppsDeps,
  own: OwnInstance,
  input: Omit<SetHolderSettingInput, "instanceId">,
  actor: string,
): Promise<InstanceSettingRow> {
  const kindName = input.kind;
  if (!Object.hasOwn(TO_KIND, kindName))
    throw new SettingInputError(`Unknown setting kind ${String(kindName)}`);
  const kind = TO_KIND[kindName];
  let name = input.name ?? "";
  let mountPath: string | null = null;
  if (kind === "file") {
    // A file's name is derived from its path (H6).
    mountPath = input.mountPath ?? "";
    checkMountPath(mountPath);
    checkFileValue(input.value);
    name = fileKey(mountPath);
  } else {
    if (!name) throw new SettingInputError("A setting needs a name");
    checkSettingName(name);
    checkSettingValue(name, input.value, kind !== "plain");
  }
  let ciphertext: string | null = null;
  if (kind !== "plain") {
    const vault = deps.holderVault;
    if (!vault) throw notConfigured("Secret settings (OPENBAO_ADDR)");
    try {
      ciphertext = await vault.encrypt(input.value);
    } catch (err) {
      // Never the name (H3) or the value; OpenBao's message stays in the log.
      deps.logger.warn(
        `[vetra-apps] encrypting a holder setting of instance ${own.row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw appsError("SERVICE_UNAVAILABLE", "Secret storage unavailable");
    }
  }
  return {
    instance_id: own.row.id,
    name,
    kind,
    mount_path: mountPath,
    value: kind === "plain" ? input.value : null,
    ciphertext,
    write_id: deps.newId(),
    updated_at: deps.now().toISOString(),
    updated_by: actor.toLowerCase(),
  };
}

/** Locks the instance row, then upserts within the cap. Returns whether it replaced a row. */
async function writeUnderCap(
  trx: Kysely<VetraAppsDB>,
  row: InstanceSettingRow,
): Promise<boolean> {
  await trx
    .selectFrom("instances")
    .select("id")
    .where("id", "=", row.instance_id)
    .forUpdate()
    .execute();
  const existing =
    (await listInstanceSettings(trx, [row.instance_id])).get(row.instance_id) ??
    [];
  const replaced = existing.some((r) => r.name === row.name);
  if (
    row.kind === "file" &&
    !replaced &&
    existing.filter((r) => r.kind === "file").length >= MAX_FILES
  )
    throw new SettingInputError(
      `An instance has at most ${MAX_FILES} files; delete one first`,
    );
  if (!replaced && existing.length >= MAX_HOLDER_SETTINGS)
    throw new SettingInputError(
      `An instance has at most ${MAX_HOLDER_SETTINGS} settings; delete one first`,
    );
  await upsertInstanceSetting(trx, row);
  return replaced;
}

const asUserInput = (err: unknown): never => {
  if (err instanceof SettingInputError)
    throw appsError("BAD_USER_INPUT", err.message);
  throw err;
};

/**
 * The holder's settings of their own instance (spec 14.2, 14.5). Holder-only
 * (H3). Secrets and files come back as names and metadata.
 */
export async function myInstanceSettingsFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<HolderSettingsJson> {
  const own = await loadOwnInstanceForHolder(deps, caller, instanceId);
  const rows =
    (await listInstanceSettings(deps.db, [own.row.id])).get(own.row.id) ?? [];
  const publisher = settingsForKind(
    await listAppSettings(deps.db, own.app.id),
    "own",
  );
  return {
    settings: rows.map(json),
    vetra: VETRA_SETTINGS,
    publisherNames: [
      ...publisher.plain.map((p) => p.name),
      ...publisher.secrets.map((s) => s.name),
    ].sort(),
    reservedNames: [...RESERVED_SETTING_NAMES].sort(),
    reservedPrefixes: [...RESERVED_PREFIXES],
  };
}

/** Sets or replaces one holder setting; the instance rolls on the reconciler's next pass. */
export async function setMyInstanceSetting(
  deps: AppsDeps,
  caller: Caller,
  input: SetHolderSettingInput,
): Promise<HolderSettingJson> {
  const own = await loadOwnInstanceForHolder(deps, caller, input.instanceId);
  const row = await prepareRow(deps, own, input, caller.address).catch(
    asUserInput,
  );
  await deps.db.transaction().execute(async (trx) => {
    const replaced = await writeUnderCap(trx, row).catch(asUserInput);
    // H3: no name, no value. Holder actions name the instance as subject.
    await auditCaller(trx, caller, {
      appId: own.app.id,
      at: row.updated_at,
      action: "instance.setting.changed",
      subject: `instance:${own.row.id}`,
      detail: {
        secret: row.kind === "secret",
        file: row.kind === "file",
        deleted: false,
        replaced,
      },
    });
  });
  deps.logger.info(
    `[vetra-apps] a holder setting of instance ${own.row.id} set by its holder`,
  );
  return json(row);
}

/** Deletes one holder setting; the instance rolls without it. */
export async function deleteMyInstanceSetting(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  name: string,
): Promise<boolean> {
  const own = await loadOwnInstanceForHolder(deps, caller, instanceId);
  const deleted = await deps.db.transaction().execute(async (trx) => {
    const gone = await deleteInstanceSetting(trx, own.row.id, name);
    if (gone)
      await auditCaller(trx, caller, {
        appId: own.app.id,
        at: deps.now().toISOString(),
        action: "instance.setting.changed",
        subject: `instance:${own.row.id}`,
        detail: { deleted: true },
      });
    return gone;
  });
  if (deleted)
    deps.logger.info(
      `[vetra-apps] a holder setting of instance ${own.row.id} deleted by its holder`,
    );
  return deleted;
}

/**
 * Internal (slice 9's switch-over, no GraphQL): copies a licensed
 * environment's holder-set settings onto the holder's own instance. Same
 * checks as setMyInstanceSetting; an entry that fails them is skipped with
 * its reason, so one odd entry never blocks a switch-over. One audit row
 * (counts only, H3).
 */
export async function importHolderSettings(
  deps: AppsDeps,
  instanceId: string,
  rows: ImportedHolderSetting[],
  actor: string,
): Promise<ImportHolderSettingsResult> {
  const own = await loadOwnInstance(deps, instanceId);
  const out: ImportHolderSettingsResult = { stored: [], skipped: [] };
  for (const input of rows) {
    const name = input.name ?? "";
    try {
      const row = await prepareRow(deps, own, input, actor);
      await deps.db
        .transaction()
        .execute((trx) => writeUnderCap(trx, row).then(() => undefined));
      out.stored.push(name);
    } catch (err) {
      if (!(err instanceof SettingInputError)) throw err;
      out.skipped.push({ name, reason: err.message });
    }
  }
  await recordAudit(deps.db, {
    appId: own.app.id,
    at: deps.now().toISOString(),
    actor: actor.toLowerCase(),
    source: "system",
    action: "instance.setting.changed",
    subject: `instance:${own.row.id}`,
    detail: {
      imported: out.stored.length,
      skipped: out.skipped.length,
      deleted: false,
    },
  });
  deps.logger.info(
    `[vetra-apps] imported ${out.stored.length} holder settings onto instance ${own.row.id} (${out.skipped.length} skipped)`,
  );
  return out;
}
