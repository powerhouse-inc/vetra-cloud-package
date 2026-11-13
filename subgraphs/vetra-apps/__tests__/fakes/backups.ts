import type {
  Counts,
  CountsResult,
  CountsRunner,
} from "../../switchover/counts-job.js";
import type { JobState, SwitchoverBackups } from "../../switchover/backups.js";
import { BackupBusyError } from "../../backups/service.js";

type Phase = JobState["status"];
export interface Job {
  id: string;
  tenant: string;
  key: string;
  status: Phase;
  error: string | null;
}

/**
 * SwitchoverBackups with controllable job states, recording every call that
 * changes something ("calls"). Like the real adapter, a start is idempotent
 * per key (dump, archive) or per attempt (restores). Jobs stay RUNNING until
 * settle() / finish(); `auto` settles each one at once.
 */
export function fakeSwitchoverBackups(o: { auto?: boolean } = {}) {
  const calls: string[] = [];
  const dumps = new Map<string, Job & { sizeBytes: number }>();
  const archives = new Map<string, Job & { sha256: string }>();
  const restores = new Map<string, Job>();
  /** Files each tenant's /data archive holds (readArchiveFiles). */
  const files = new Map<string, Map<string, Buffer>>();
  const busy = new Set<string>();
  const failStart = new Set<string>();
  let auto = o.auto ?? false;
  let n = 0;
  const first = <T extends Job>(
    m: Map<string, T>,
    tenant: string,
    key: string,
  ) =>
    [...m.values()].find(
      (j) => j.tenant === tenant && j.key === key && j.status !== "FAILED",
    );
  const settled = (): Phase => (auto ? "READY" : "RUNNING");

  const api: SwitchoverBackups = {
    async startDump(i) {
      if (failStart.has("dump")) throw new Error("dump could not start");
      if (busy.has(i.tenant)) throw new BackupBusyError("busy");
      const found = first(dumps, i.tenant, i.key);
      if (found) return { dumpId: found.id };
      const id = `dump-${++n}`;
      dumps.set(id, {
        id,
        tenant: i.tenant,
        key: i.key,
        status: settled(),
        error: null,
        sizeBytes: 1000,
      });
      calls.push(`startDump ${i.tenant} ${i.key}`);
      return { dumpId: id };
    },
    async dumpStatus(id) {
      const j = dumps.get(id);
      return {
        status: j?.status ?? "FAILED",
        error: j ? j.error : "gone",
        startedAt: null,
        finishedAt: null,
        sizeBytes: j?.status === "READY" ? j.sizeBytes : null,
      };
    },
    async startArchive(i) {
      if (failStart.has("archive")) throw new Error("archive could not start");
      if (busy.has(i.tenant)) throw new BackupBusyError("busy");
      const found = first(archives, i.tenant, i.key);
      if (found) return { archiveId: found.id };
      const id = `archive-${++n}`;
      archives.set(id, {
        id,
        tenant: i.tenant,
        key: i.key,
        status: settled(),
        error: null,
        sha256: `${n}`.padStart(64, "a"),
      });
      calls.push(
        `startArchive ${i.tenant} ${i.key}${i.sameNodeAs ? " sameNode" : ""}`,
      );
      return { archiveId: id };
    },
    async archiveStatus(id) {
      const j = archives.get(id);
      return {
        status: j?.status ?? "FAILED",
        error: j ? j.error : "gone",
        startedAt: null,
        finishedAt: null,
        sha256: j?.status === "READY" ? j.sha256 : null,
        files: null,
        bytes: j?.status === "READY" ? 2000 : null,
      };
    },
    async startRestoreDump(i) {
      const d = dumps.get(i.dumpId);
      if (!d || d.status !== "READY") throw new Error("the dump is not ready");
      if (d.tenant === i.targetTenant) throw new Error("another tenant");
      const id = `${i.targetTenant}/pgfresh-${i.dumpId}${i.attempt ? `-${i.attempt}` : ""}`;
      if (!restores.has(id)) {
        restores.set(id, {
          id,
          tenant: i.targetTenant,
          key: "db",
          status: settled(),
          error: null,
        });
        calls.push(
          `restoreDump ${i.targetTenant}${i.reset ? " reset" : ""} jobs=${i.jobs}`,
        );
      }
      return { restoreId: id };
    },
    async startRestoreArchive(i) {
      const a = archives.get(i.archiveId);
      if (!a || a.status !== "READY")
        throw new Error("the archive is not ready");
      if (a.tenant === i.targetTenant) throw new Error("another tenant");
      const id = `${i.targetTenant}/datarestore-${i.archiveId}${i.attempt ? `-${i.attempt}` : ""}`;
      if (!restores.has(id)) {
        restores.set(id, {
          id,
          tenant: i.targetTenant,
          key: "data",
          status: settled(),
          error: null,
        });
        calls.push(`restoreArchive ${i.targetTenant}`);
      }
      return { restoreId: id };
    },
    async restoreStatus(id) {
      const j = restores.get(id);
      return {
        status: j?.status ?? "FAILED",
        error: j ? j.error : "gone",
        startedAt: null,
        finishedAt: null,
      };
    },
    async readArchiveFiles(archiveId, names) {
      const a = archives.get(archiveId);
      if (!a || a.status !== "READY")
        throw new Error("the archive is not ready");
      const have = files.get(a.tenant) ?? new Map<string, Buffer>();
      return new Map(
        names.flatMap((name) => {
          const f = have.get(name);
          return f ? [[name, f] as const] : [];
        }),
      );
    },
  };

  return {
    api,
    calls,
    dumps,
    archives,
    restores,
    files,
    /** Tenants whose dump/archive slot is taken (starts throw BackupBusyError). */
    busy,
    /** "dump" | "archive": the start throws. */
    failStart,
    setAuto(v: boolean) {
      auto = v;
    },
    /** RUNNING jobs become READY (or FAILED with `error`); `kind`: which kind, default all. */
    settle(kind?: "dump" | "archive" | "restore", error?: string) {
      const sets = {
        dump: dumps as Map<string, Job>,
        archive: archives as Map<string, Job>,
        restore: restores,
      };
      for (const [k, m] of Object.entries(sets))
        if (!kind || kind === k)
          for (const j of m.values())
            if (j.status === "RUNNING") {
              j.status = error ? "FAILED" : "READY";
              j.error = error ?? null;
            }
    },
    count(prefix: string) {
      return calls.filter((c) => c.startsWith(prefix)).length;
    },
  };
}
export type FakeSwitchoverBackups = ReturnType<typeof fakeSwitchoverBackups>;

export const COUNTS: Counts = {
  documentsByType: { "powerhouse/document-drive": 2, "x/workflow": 5 },
  operations: 1000,
  attachments: 3,
  workflowSecrets: 2,
  keyCheck: "kc-1",
};

/** CountsRunner with programmable counts per tenant; a run is READY once its tenant has counts (or at once with `auto`). */
export function fakeCounts() {
  const calls: string[] = [];
  const byTenant = new Map<string, Counts | { error: string }>();
  const started = new Set<string>();
  const runner: CountsRunner = {
    async start({ tenant, runId }) {
      if (started.has(`${tenant}/${runId}`)) return;
      started.add(`${tenant}/${runId}`);
      calls.push(`counts ${tenant} ${runId}`);
    },
    async result({ tenant, runId }): Promise<CountsResult> {
      if (!started.has(`${tenant}/${runId}`))
        return { status: "FAILED", error: "no such run" };
      const c = byTenant.get(tenant);
      if (!c) return { status: "RUNNING" };
      return "error" in c
        ? { status: "FAILED", error: c.error }
        : { status: "READY", counts: c };
    },
  };
  return { runner, calls, byTenant };
}
export type FakeCounts = ReturnType<typeof fakeCounts>;
