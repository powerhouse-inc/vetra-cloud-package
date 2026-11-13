import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { BackupBusyError } from "../backups/service.js";
import { switchoverConfigOf, type SwitchoverConfig } from "../config.js";
import { getHold } from "../holds/repo.js";
import { appPodGone, holdEnvironment, releaseHold } from "../holds/service.js";
import { INSTANCE_BASE_DOMAIN } from "../instances/reconciler.js";
import { insertInstance, type InstanceRow } from "../instances/repo.js";
import { targetOf } from "../instances/targets.js";
import { ownInstanceName } from "../plans/sync.js";
import { getPlan } from "../plans/repo.js";
import { releaseByVersion } from "../releases/repo.js";
import { getApp } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { frozenReasonOf } from "../../vetra-licensing/rollout-db.js";
import {
  SwitchoverBackupsUnavailableError,
  switchoverKeys,
} from "./backups.js";
import { gatherSwitchoverFacts, checkSwitchover } from "./checks.js";
import { firstCountDifference, type Counts } from "./counts-job.js";
import {
  fingerprintsOf,
  KEY_FILES,
  parseFingerprints,
  parseKeyFiles,
  tenantOfEnvironment,
  TENANT_KEYS,
  type KeyValues,
} from "./keys.js";
import type { Observation } from "./machine.js";
import type { SwitchoverPorts } from "./ports.js";
import {
  instanceOfSwitchover,
  listSwitchovers,
  updateSwitchover,
  type SwitchoverRow,
  type SwitchoverState,
} from "./repo.js";

export interface StepCtx {
  deps: AppsDeps;
  ports: SwitchoverPorts;
  cfg: SwitchoverConfig;
  nowIso: string;
}
export type Step = (c: StepCtx, row: SwitchoverRow) => Promise<Observation>;

export const wait: Observation = { kind: "wait" };
export const fail = (error: string): Observation => ({ kind: "fail", error });
export const advance = (patch?: Partial<SwitchoverRow>): Observation => ({
  kind: "advance",
  patch,
});

export const NOT_FROZEN = "the App's gated releases are not frozen";
const PAST_PREPARED: ReadonlySet<SwitchoverState> = new Set([
  "HOLDING_OLD",
  "BACKING_UP",
  "RESTORING",
  "CHECKING_COPY",
  "STARTING",
  "VERIFYING",
  "LINKING",
  "AWAITING_CONFIRMATION",
  "ROLLING_BACK",
]);

/** The keys read out of the old archive, held in memory only (never a table, a log or an audit row). */
const keyCache = new Map<string, KeyValues>();

const save = (c: StepCtx, row: SwitchoverRow, patch: Partial<SwitchoverRow>) =>
  updateSwitchover(c.deps.db, row.id, patch, c.nowIso, row.state);

const runId = (row: SwitchoverRow, phase: string) =>
  `${row.id.slice(0, 8)}-${phase}${row.attempts}`;

const json = (o: unknown) => JSON.stringify(o);

/** Re-run the eligibility checks (anything new refuses); "not frozen" only counts when `frozen` is asked. */
async function refusals(
  c: StepCtx,
  row: SwitchoverRow,
  o: { frozen: boolean },
): Promise<string[]> {
  const facts = await gatherSwitchoverFacts(
    c.deps,
    row.environment_id,
    row.mode,
  );
  return checkSwitchover(facts).filter((r) => o.frozen || r !== NOT_FROZEN);
}

export async function newInstance(
  c: StepCtx,
  row: SwitchoverRow,
): Promise<InstanceRow | null> {
  return instanceOfSwitchover(c.deps.db, row);
}

/** The new instance's tenant, from its environment's subdomain: the reconciler's own formula. */
export async function newTenant(
  c: StepCtx,
  inst: InstanceRow,
): Promise<string | null> {
  if (!inst.environment_id) return null;
  const state = await c.deps.envs.getState(inst.environment_id);
  return tenantOfEnvironment(state, inst.host ?? "", inst.environment_id);
}

const neverStarted = (row: SwitchoverRow, inst: InstanceRow) =>
  !row.started_at && !inst.running_digest;

/** Why the keys of the new tenant do not match, or null when both do. */
async function keyMismatch(
  c: StepCtx,
  tenant: string,
  row: SwitchoverRow,
): Promise<string | null> {
  const fp = parseFingerprints(row.key_fingerprints);
  if (!fp || !c.deps.instanceSecrets)
    return "the old keys are not fingerprinted";
  for (const k of ["master", "attachment"] as const)
    if (
      (await c.deps.instanceSecrets.secretFingerprint(
        tenant,
        TENANT_KEYS[k],
      )) !== fp[k]
    )
      return `the new tenant's ${k} key is not the old environment's`;
  return null;
}

type Counted = { wait: true } | { fail: string } | { counts: Counts };

async function runCounts(
  c: StepCtx,
  tenant: string,
  id: string,
): Promise<Counted> {
  await c.ports.counts.start({ tenant, runId: id });
  const r = await c.ports.counts.result({ tenant, runId: id });
  if (r.status === "RUNNING") return { wait: true };
  if (r.status === "FAILED") return { fail: `counts of ${tenant}: ${r.error}` };
  return { counts: r.counts };
}

/** Everything a step can say about a job, in one shape. */
function jobWait(
  what: string,
  s: { status: string; error: string | null },
): Observation | null {
  if (s.status === "FAILED") return fail(`${what}: ${s.error ?? "failed"}`);
  if (s.status !== "READY") return wait;
  return null;
}

const timingKey = (state: string) => state.toLowerCase();

// ---------------------------------------------------------------- PLANNED

const planned: Step = async (c, row) => {
  if (row.mode === "dry_run") return advance();
  if (!row.window_start) return fail("a real switch-over has no window");
  const due = Date.parse(row.window_start) - c.cfg.leadHours * 3_600_000;
  return Date.parse(c.nowIso) >= due ? advance() : wait;
};

// -------------------------------------------------------------- PREPARING

/** Reads the old environment's two key files from a (same-node, read-only) /data archive. */
async function readOldKeys(
  c: StepCtx,
  row: SwitchoverRow,
): Promise<{ obs: Observation } | { row: SwitchoverRow; keys: KeyValues }> {
  const pvc = await c.ports.dataPvc(row.old_tenant);
  if (!pvc) return { obs: fail("the old environment has no /data volume") };
  const pod = await c.ports.runningAppPod(row.old_tenant);
  let archiveId: string;
  try {
    archiveId = (
      await c.ports.backups.startArchive({
        tenant: row.old_tenant,
        pvc,
        key: switchoverKeys(row.id, "keys-").archive,
        sameNodeAs: pod ? { namespace: row.old_tenant, pod } : undefined,
      })
    ).archiveId;
  } catch (err) {
    if (err instanceof BackupBusyError) return { obs: wait };
    throw err;
  }
  if (row.prepare_archive_id !== archiveId)
    row = await save(c, row, { prepare_archive_id: archiveId });
  const st = await c.ports.backups.archiveStatus(archiveId);
  const w = jobWait("reading the old keys", st);
  if (w) return { obs: w };
  const keys = parseKeyFiles(
    await c.ports.backups.readArchiveFiles(archiveId, KEY_FILES),
  );
  if (!keys)
    return {
      obs: fail(
        "the old environment has no kept keys on /data (workflows-master-key, attachment-url-signing-secret)",
      ),
    };
  return { row, keys };
}

const preparing: Step = async (c, row) => {
  const bad = await refusals(c, row, { frozen: false });
  if (bad.length > 0)
    return fail(`no longer eligible: ${bad.slice(0, 3).join("; ")}`);
  const secrets = c.deps.instanceSecrets;
  if (!secrets) return fail("the tenant secrets store is not configured");

  // (a) the keys, fingerprinted (values stay in memory).
  let fp = parseFingerprints(row.key_fingerprints);
  if (!fp) {
    const r = await readOldKeys(c, row);
    if ("obs" in r) return r.obs;
    keyCache.set(row.id, r.keys);
    fp = fingerprintsOf(r.keys);
    row = await save(c, r.row, { key_fingerprints: json(fp) });
  }

  // (b) the instance row.
  let inst = await newInstance(c, row);
  if (!inst) {
    const app = await getApp(c.deps.db, row.app_id);
    const plan = await getPlan(c.deps.db, row.plan_id);
    const release = await releaseByVersion(
      c.deps.db,
      row.app_id,
      row.release_version,
    );
    if (!app || !plan || !release)
      return fail("the App, plan or pinned release is gone");
    if (release.image_digest !== row.release_digest)
      return fail("the pinned release's image digest changed");
    const dry = row.mode === "dry_run";
    const nowIso = c.nowIso;
    inst = await insertInstance(c.deps.db, {
      id: c.deps.newId(),
      app_id: row.app_id,
      kind: "own",
      name: dry
        ? `rehearsal-${row.id.slice(0, 8)}`
        : ownInstanceName(row.licence_root_id),
      branch: null,
      pr: null,
      host: dry ? `rehearsal-${row.id.slice(0, 8)}` : row.old_host,
      environment_id: null,
      ...targetOf(release),
      running_version: null,
      running_digest: null,
      running_repository: null,
      status: "pending",
      reason: null,
      failed_digest: null,
      update_started_at: null,
      removed_at: null,
      removed_reason: null,
      plan_id: plan.id,
      holder_address: dry ? null : row.holder_address,
      licence_root_id: dry ? null : row.licence_root_id,
      licence_ended_at: null,
      stop_reason: null,
      stopped_by_vetra: false,
      target_size: plan.size,
      switchover_id: row.id,
      created_at: nowIso,
      updated_at: nowIso,
    });
  }
  if (row.instance_id !== inst.id)
    row = await save(c, row, { instance_id: inst.id });
  // The reconciler creates the document (never started: the guard).
  if (!inst.environment_id) return wait;

  // (c) the hold, before anything sets the version.
  await holdEnvironment(c.deps, {
    environmentId: inst.environment_id,
    reason: `switch-over ${row.id}`,
    switchoverId: row.id,
    by: AUDIT_SYSTEM_ACTOR,
  });

  // (d) the old keys into the new tenant, before the first start.
  const tenant = await newTenant(c, inst);
  if (!tenant) return wait;
  let keys = keyCache.get(row.id) ?? null;
  const values = async (): Promise<KeyValues | null> => {
    if (keys) return keys;
    if (!row.prepare_archive_id) return null;
    const read = parseKeyFiles(
      await c.ports.backups.readArchiveFiles(row.prepare_archive_id, KEY_FILES),
    );
    const f = read && fingerprintsOf(read);
    if (!read || !f || f.master !== fp.master || f.attachment !== fp.attachment)
      return null;
    keys = read;
    keyCache.set(row.id, read);
    return read;
  };
  for (const k of ["master", "attachment"] as const) {
    const key = TENANT_KEYS[k];
    let have = await secrets.secretFingerprint(tenant, key);
    if (have === fp[k]) continue;
    const v = await values();
    if (!v)
      return fail(`the old ${k} key cannot be read again; nothing was written`);
    if (have === null) {
      // Never replaces a key that is already there.
      await secrets.ensureSecret(tenant, key, () => v[k]);
      have = await secrets.secretFingerprint(tenant, key);
    }
    if (have !== fp[k]) {
      // Only a key Vetra generated for an instance that never started may be replaced; the master key never.
      if (k === "attachment" && neverStarted(row, inst)) {
        await secrets.setSecrets(tenant, [{ key, value: v[k] }]);
        have = await secrets.secretFingerprint(tenant, key);
      }
      if (have !== fp[k])
        return fail(
          `the new tenant already holds a different ${k} key; it was not replaced`,
        );
    }
  }

  // (e) the database and the volume exist (the reconciler set the version under the hold).
  if (!(await c.ports.storage.databaseReady(tenant))) return wait;
  if (!(await c.ports.storage.dataVolumeBound(tenant))) return wait;
  keyCache.delete(row.id);
  return advance({
    instance_id: inst.id,
    key_fingerprints: row.key_fingerprints,
    prepare_archive_id: row.prepare_archive_id,
  });
};

// --------------------------------------------------------------- PREPARED

const prepared: Step = async (c, row) => {
  if (row.mode === "dry_run") return advance();
  if (!row.window_start) return fail("a real switch-over has no window");
  if (Date.parse(c.nowIso) < Date.parse(row.window_start)) return wait;
  // One switch-over of an App at a time past PREPARED.
  const others = (await listSwitchovers(c.deps.db, row.app_id)).filter(
    (s) =>
      s.id !== row.id &&
      s.mode === "real" &&
      (PAST_PREPARED.has(s.state) ||
        (s.state === "FAILED" &&
          s.failed_state !== null &&
          PAST_PREPARED.has(s.failed_state))),
  );
  return others.length > 0 ? wait : advance();
};

// ------------------------------------------------------------ HOLDING_OLD

const holdingOld: Step = async (c, row) => {
  // Checked before the hold is placed (the hold itself changes the old environment's status).
  if (!(await getHold(c.deps.db, row.environment_id))) {
    const bad = await refusals(c, row, { frozen: true });
    if (bad.length > 0)
      return fail(`no longer eligible: ${bad.slice(0, 3).join("; ")}`);
  }
  if (c.deps.licensingDb) {
    const reason = await frozenReasonOf(c.deps.licensingDb, row.app_id);
    if (reason === null) return fail(NOT_FROZEN);
  }
  await holdEnvironment(c.deps, {
    environmentId: row.environment_id,
    reason: `switch-over ${row.id}`,
    switchoverId: row.id,
    by: AUDIT_SYSTEM_ACTOR,
  });
  if (!(await appPodGone(c.deps, row.old_tenant))) return wait;
  return advance({ downtime_started_at: row.downtime_started_at ?? c.nowIso });
};

// ------------------------------------------------------------- BACKING_UP

const backingUp: Step = async (c, row) => {
  const keys = switchoverKeys(row.id);
  const b = c.ports.backups;
  let dumpId: string;
  let archiveId: string;
  try {
    dumpId = (
      await b.startDump({
        tenant: row.old_tenant,
        environmentId: row.environment_id,
        key: keys.dump,
      })
    ).dumpId;
    if (row.dump_id !== dumpId) row = await save(c, row, { dump_id: dumpId });
    const pvc = await c.ports.dataPvc(row.old_tenant);
    if (!pvc) return fail("the old environment has no /data volume");
    // A dry run archives beside the running pod (read-only); a real run's pod is gone.
    const pod =
      row.mode === "dry_run"
        ? await c.ports.runningAppPod(row.old_tenant)
        : null;
    archiveId = (
      await b.startArchive({
        tenant: row.old_tenant,
        pvc,
        key: keys.archive,
        sameNodeAs: pod ? { namespace: row.old_tenant, pod } : undefined,
      })
    ).archiveId;
    if (row.archive_id !== archiveId)
      row = await save(c, row, { archive_id: archiveId });
  } catch (err) {
    if (err instanceof BackupBusyError) return wait;
    throw err;
  }
  const counted = await runCounts(c, row.old_tenant, runId(row, "src"));
  const dump = await b.dumpStatus(dumpId);
  const archive = await b.archiveStatus(archiveId);
  const w =
    jobWait("database dump", dump) ??
    jobWait("/data archive", archive) ??
    ("fail" in counted ? fail(counted.fail) : null);
  if (w) return w;
  if (!("counts" in counted)) return wait;
  return advance({ source_counts: json(counted.counts) });
};

// -------------------------------------------------------------- RESTORING

const restoring: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  const archive = row.archive_id;
  if (!inst?.environment_id || !row.dump_id || !archive)
    return fail("the new instance or the copy is missing");
  // Never restore into an instance that is not held (it may run).
  if (!(await getHold(c.deps.db, inst.environment_id)))
    return fail("the new instance is not held; refusing to restore into it");
  const tenant = await newTenant(c, inst);
  if (!tenant) return fail("the new instance's tenant is unknown");
  const mismatch = await keyMismatch(c, tenant, row);
  if (mismatch) return fail(`${mismatch}; refusing to restore`);
  const b = c.ports.backups;
  // A retry (resume) is a new attempt: a database a failed restore left behind is reset (it never started).
  const retry = row.attempts > 0;
  if (retry && !neverStarted(row, inst))
    return fail("the new instance may have started; refusing to reset it");
  let dbId: string;
  let dataId: string;
  try {
    dbId = (
      await b.startRestoreDump({
        dumpId: row.dump_id,
        targetTenant: tenant,
        mode: "fresh",
        jobs: c.cfg.restoreJobs,
        attempt: row.attempts,
        reset: retry,
      })
    ).restoreId;
    if (row.restore_db_id !== dbId)
      row = await save(c, row, { restore_db_id: dbId });
    const pvc = await c.ports.dataPvc(tenant);
    if (!pvc) return wait;
    dataId = (
      await b.startRestoreArchive({
        archiveId: archive,
        targetTenant: tenant,
        pvc,
        attempt: row.attempts,
      })
    ).restoreId;
    if (row.restore_data_id !== dataId)
      row = await save(c, row, { restore_data_id: dataId });
  } catch (err) {
    if (
      err instanceof BackupBusyError ||
      err instanceof SwitchoverBackupsUnavailableError
    )
      return wait;
    throw err;
  }
  const w =
    jobWait("database restore", await b.restoreStatus(dbId)) ??
    jobWait("/data restore", await b.restoreStatus(dataId));
  return w ?? advance();
};

// ---------------------------------------------------------- CHECKING_COPY

const checkingCopy: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  const source = row.source_counts
    ? (JSON.parse(row.source_counts) as Counts)
    : null;
  if (!inst?.environment_id || !source)
    return fail("the source counts or the new instance are missing");
  if (!(await getHold(c.deps.db, inst.environment_id)))
    return fail("the new instance is not held");
  const tenant = await newTenant(c, inst);
  if (!tenant) return fail("the new instance's tenant is unknown");
  const mismatch = await keyMismatch(c, tenant, row);
  if (mismatch) return fail(mismatch);
  const counted = await runCounts(c, tenant, runId(row, "copy"));
  if ("wait" in counted) return wait;
  if ("fail" in counted) return fail(counted.fail);
  // Exactly equal, operations included: nothing wrote to the old database since the dump.
  const diff = firstCountDifference(source, counted.counts);
  if (diff) return fail(`the copy differs from the source in ${diff}`);
  return advance({ copy_counts: json(counted.counts) });
};

// --------------------------------------------------------------- STARTING

const starting: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  if (!inst?.environment_id) return fail("the new instance is missing");
  // Never started on half a copy, or on other keys.
  if (!row.copy_counts) return fail("the copy was not checked; not starting");
  const tenant = await newTenant(c, inst);
  if (!tenant) return fail("the new instance's tenant is unknown");
  const mismatch = await keyMismatch(c, tenant, row);
  if (mismatch) return fail(`${mismatch}; not starting`);
  await releaseHold(c.deps, inst.environment_id);
  return advance();
};

// -------------------------------------------------------------- VERIFYING

/** Slice 3's readiness under health enforce: ready on the pinned digest, not degraded. */
export function instanceReady(
  inst: InstanceRow,
  digest: string,
): { ready: boolean; reason: string | null } {
  if (inst.status === "failed")
    return { ready: false, reason: inst.reason ?? "the instance failed" };
  const ready =
    inst.status === "ready" &&
    inst.running_digest === digest &&
    !inst.running_degraded;
  return { ready, reason: ready ? null : (inst.reason ?? inst.status) };
}

const verifying: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  const source = row.source_counts
    ? (JSON.parse(row.source_counts) as Counts)
    : null;
  if (!inst?.environment_id || !source)
    return fail("the new instance or the source counts are missing");
  const state = instanceReady(inst, row.release_digest);
  if (inst.status === "failed")
    return fail(`the new instance failed to start: ${state.reason}`);
  if (!state.ready) return wait;
  if (!row.started_at) row = await save(c, row, { started_at: c.nowIso });
  const tenant = await newTenant(c, inst);
  if (!tenant) return fail("the new instance's tenant is unknown");
  const counted = await runCounts(c, tenant, runId(row, "start"));
  if ("wait" in counted) return wait;
  if ("fail" in counted) return fail(counted.fail);
  // Migrations may add operations; nothing else changes.
  const diff = firstCountDifference(source, counted.counts, {
    operations: false,
  });
  if (diff)
    return fail(`the started instance differs from the source in ${diff}`);
  if (!c.deps.probe) return fail("no HTTP probe is configured; cannot verify");
  const probe = await c.deps.probe(
    `https://${inst.host}.${INSTANCE_BASE_DOMAIN}/`,
  );
  if (probe.status !== 200 || !/html/i.test(probe.contentType ?? ""))
    return wait;
  return advance({
    started_counts: json(counted.counts),
    started_at: row.started_at ?? c.nowIso,
  });
};

// ---------------------------------------------------------------- LINKING

const linking: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  if (!inst) return fail("the new instance is missing");
  const lic = c.deps.licensingDb;
  if (!lic) return fail("licensing is not configured");
  // Licensing first, each "if null": a crash in between is finished by the next pass.
  await lic
    .updateTable("license_environments")
    .set({ switched_over_at: c.nowIso, switched_over_instance_id: inst.id })
    .where("environment_id", "=", row.environment_id)
    .where("switched_over_at", "is", null)
    .execute();
  await c.deps.db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable("instances")
      .set({ switchover_id: null, updated_at: c.nowIso })
      .where("id", "=", inst.id)
      .where("switchover_id", "=", row.id)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) > 0)
      await recordAudit(trx, {
        appId: row.app_id,
        at: c.nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action: "switchover.linked",
        subject: `switchover:${row.id}`,
        detail: {
          environmentId: row.environment_id,
          instanceId: inst.id,
          host: row.old_host,
        },
      });
  });
  return advance();
};

// ------------------------------------------------- AWAITING_CONFIRMATION

const awaitingConfirmation: Step = async (c, row) => {
  const since = Date.parse(row.started_at ?? row.step_started_at ?? c.nowIso);
  const unanswered =
    Date.parse(c.nowIso) - since >= c.cfg.confirmHours * 3_600_000;
  if (!row.confirmed_at && !unanswered) return wait;
  return advance({
    confirmed_at: row.confirmed_at ?? c.nowIso,
    hold_until: new Date(
      Date.parse(c.nowIso) + c.cfg.holdDays * 86_400_000,
    ).toISOString(),
  });
};

const idle: Step = async () => wait;

export const STEPS: Record<SwitchoverState, Step> = {
  PLANNED: planned,
  PREPARING: preparing,
  PREPARED: prepared,
  HOLDING_OLD: holdingOld,
  BACKING_UP: backingUp,
  RESTORING: restoring,
  CHECKING_COPY: checkingCopy,
  STARTING: starting,
  VERIFYING: verifying,
  LINKING: linking,
  AWAITING_CONFIRMATION: awaitingConfirmation,
  DONE: idle,
  CLEANING: idle,
  CLEANED: idle,
  FAILED: idle,
  ROLLING_BACK: idle,
  ROLLED_BACK: idle,
};

export { switchoverConfigOf, timingKey };
