import { PGlite } from "@electric-sql/pglite";
import { Readable } from "node:stream";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { reconcileArchiveJob } from "../../vetra-cloud-observability/dumps/archive-watcher.js";
import { reconcileJob } from "../../vetra-cloud-observability/dumps/watcher.js";
import { BackupBusyError } from "../backups/service.js";
import {
  readFilesFromTarZst,
  MAX_FILE_BYTES,
} from "../switchover/archive-files.js";
import {
  createSwitchoverBackups,
  switchoverKeys,
  SwitchoverBackupsUnavailableError,
  SWITCHOVER_KEEP_DAYS,
} from "../switchover/backups.js";
import {
  buildCountsJob,
  COUNTS_SQL,
  createCountsRunner,
  firstCountDifference,
  parseCounts,
} from "../switchover/counts-job.js";
import { backupHarness, type BackupCtx } from "./backups-fixtures.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

const OLD = "old-tenant";
const NEW = "new-tenant";
const keys = switchoverKeys("sw1");
const DAY = 86_400_000;

function adapter(files?: Buffer) {
  const { h } = ctx;
  const deps = {
    backups: {
      ...h.deps.backups!,
      readObject: async () => Readable.from([files ?? Buffer.alloc(0)]),
    },
    observabilityDb: h.obsDb,
    now: () => new Date("2026-11-20T10:00:00.000Z"),
  };
  return createSwitchoverBackups(deps);
}

describe("startDump", () => {
  it("dumps under switchover/, source SWITCHOVER, kept 180 days, with a long deadline; once per key", async () => {
    const a = adapter();
    const { dumpId } = await a.startDump({
      tenant: OLD,
      environmentId: "env-old",
      key: keys.dump,
    });
    const row = await new DumpsRepo(ctx.h.obsDb).getById(dumpId);
    expect(row).toMatchObject({
      tenantId: OLD,
      documentId: "env-old",
      source: "SWITCHOVER",
      s3Key: "switchover/sw1/db.dump",
      requestedBy: "vetra",
    });
    expect(Date.parse(row!.expiresAt) - Date.parse(row!.requestedAt)).toBe(
      SWITCHOVER_KEEP_DAYS * DAY,
    );
    const job = ctx.fake.jobs.get(`pgdump-${dumpId}`)!;
    expect(job.ns).toBe(OLD);
    expect(job.job.spec!.activeDeadlineSeconds).toBe(4 * 3600);
    const env = job.job.spec!.template.spec!.containers[0].env!;
    expect(env.find((e) => e.name === "S3_KEY")?.value).toBe(keys.dump);
    // A crash between the Job and the row update: the next call finds the dump.
    expect(
      (
        await a.startDump({
          tenant: OLD,
          environmentId: "env-old",
          key: keys.dump,
        })
      ).dumpId,
    ).toBe(dumpId);
    expect(
      [...ctx.fake.jobs.keys()].filter((n) => n.startsWith("pgdump-")),
    ).toHaveLength(1);
  });

  it("refuses a key outside switchover/ and waits when the tenant's dump slot is taken", async () => {
    const a = adapter();
    await expect(
      a.startDump({ tenant: OLD, environmentId: "e", key: "x/db.dump" }),
    ).rejects.toThrow(/switchover\//);
    await new DumpsRepo(ctx.h.obsDb).create({
      documentId: "e",
      tenantId: OLD,
      requestedBy: "0x1",
      now: new Date(),
    });
    await expect(
      a.startDump({ tenant: OLD, environmentId: "e", key: keys.dump }),
    ).rejects.toBeInstanceOf(BackupBusyError);
  });

  it("a failed dump is replaced by a new one under the same key", async () => {
    const a = adapter();
    const first = await a.startDump({
      tenant: OLD,
      environmentId: "e",
      key: keys.dump,
    });
    await new DumpsRepo(ctx.h.obsDb).markFailed(
      first.dumpId,
      "boom",
      new Date(),
    );
    expect((await a.dumpStatus(first.dumpId)).status).toBe("FAILED");
    const second = await a.startDump({
      tenant: OLD,
      environmentId: "e",
      key: keys.dump,
    });
    expect(second.dumpId).not.toBe(first.dumpId);
  });
});

describe("startArchive", () => {
  it("archives under switchover/, read-only; beside the running pod only on request; kept 180 days", async () => {
    const a = adapter();
    const { archiveId } = await a.startArchive({
      tenant: OLD,
      pvc: "powerhouse-old-app-data",
      key: keys.archive,
      sameNodeAs: { namespace: OLD, pod: "app-0" },
    });
    const row = await new ArchivesRepo(ctx.h.obsDb).getById(archiveId);
    expect(row).toMatchObject({ tenantId: OLD, s3Key: keys.archive });
    expect(Date.parse(row!.expiresAt) - Date.parse(row!.requestedAt)).toBe(
      SWITCHOVER_KEEP_DAYS * DAY,
    );
    const spec = ctx.fake.jobs.get(`dataarchive-${archiveId}`)!.job.spec!
      .template.spec!;
    expect(spec.affinity).toBeDefined();
    expect(spec.volumes![0].persistentVolumeClaim).toMatchObject({
      readOnly: true,
    });
    expect(spec.containers[0].volumeMounts![0].readOnly).toBe(true);
    expect(
      spec.containers[0].env!.find((e) => e.name === "S3_KEY")?.value,
    ).toBe(keys.archive);
    expect(
      (await a.startArchive({ tenant: OLD, pvc: "p", key: keys.archive }))
        .archiveId,
    ).toBe(archiveId);
  });

  it("without sameNodeAs no affinity (the old pod is gone); a busy tenant is a busy error", async () => {
    const a = adapter();
    const { archiveId } = await a.startArchive({
      tenant: OLD,
      pvc: "p",
      key: keys.archive,
    });
    expect(
      ctx.fake.jobs.get(`dataarchive-${archiveId}`)!.job.spec!.template.spec!
        .affinity,
    ).toBeUndefined();
    await expect(
      a.startArchive({
        tenant: OLD,
        pvc: "p",
        key: "switchover/sw2/data.tar.zst",
      }),
    ).rejects.toBeInstanceOf(BackupBusyError);
  });
});

async function readyDump(tenant = OLD) {
  const repo = new DumpsRepo(ctx.h.obsDb);
  const a = adapter();
  const { dumpId } = await a.startDump({
    tenant,
    environmentId: "e",
    key: keys.dump,
  });
  await repo.markReady(dumpId, keys.dump, 5, new Date());
  return dumpId;
}
async function readyArchive(tenant = OLD) {
  const repo = new ArchivesRepo(ctx.h.obsDb);
  const { archiveId } = await adapter().startArchive({
    tenant,
    pvc: "p",
    key: keys.archive,
  });
  await repo.markReady(archiveId, keys.archive, 9, "a".repeat(64), new Date());
  return archiveId;
}

describe("restores into another tenant", () => {
  it("dump: a fresh-target Job in the target namespace, from the switchover key, never the dump's own tenant", async () => {
    const dumpId = await readyDump();
    const a = adapter();
    await expect(
      a.startRestoreDump({ dumpId, targetTenant: OLD, mode: "fresh", jobs: 4 }),
    ).rejects.toThrow(/another tenant/);
    const { restoreId } = await a.startRestoreDump({
      dumpId,
      targetTenant: NEW,
      mode: "fresh",
      jobs: 4,
    });
    expect(restoreId).toBe(`${NEW}/pgfresh-${dumpId}`);
    const job = ctx.fake.jobs.get(`pgfresh-${dumpId}`)!;
    expect(job.ns).toBe(NEW);
    const c = job.job.spec!.template.spec!.containers[0];
    const env = Object.fromEntries(c.env!.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({
      S3_KEY: keys.dump,
      RESTORE_JOBS: "4",
      PGHOST: `${NEW}-pg-rw.${NEW}.svc.cluster.local`,
    });
    expect(env.RESET_TARGET).toBeUndefined();
    const script = c.args![0];
    expect(script).not.toMatch(/DROP OWNED BY CURRENT_USER CASCADE;'/);
    expect(script).toContain("refusing to restore");
    expect(script).toContain(
      "pg_restore --no-owner --no-acl --exit-on-error -j",
    );
    // The same attempt is not created twice; a retry is a new Job (and may reset a never-started target).
    await a.startRestoreDump({
      dumpId,
      targetTenant: NEW,
      mode: "fresh",
      jobs: 4,
    });
    const again = await a.startRestoreDump({
      dumpId,
      targetTenant: NEW,
      mode: "fresh",
      jobs: 4,
      attempt: 1,
      reset: true,
    });
    expect(again.restoreId).toBe(`${NEW}/pgfresh-${dumpId}-1`);
    expect(
      ctx.fake.jobs
        .get(`pgfresh-${dumpId}-1`)!
        .job.spec!.template.spec!.containers[0].env!.find(
          (e) => e.name === "RESET_TARGET",
        )?.value,
    ).toBe("1");
    expect(
      [...ctx.fake.jobs.keys()].filter((n) => n.startsWith("pgfresh-")),
    ).toHaveLength(2);
  });

  it("dump: refuses a dump that is not ready or not a switch-over's", async () => {
    const a = adapter();
    const { dumpId } = await a.startDump({
      tenant: OLD,
      environmentId: "e",
      key: keys.dump,
    });
    await expect(
      a.startRestoreDump({ dumpId, targetTenant: NEW, mode: "fresh", jobs: 4 }),
    ).rejects.toThrow(/not ready/);
    await new DumpsRepo(ctx.h.obsDb).markReady(
      dumpId,
      keys.dump,
      1,
      new Date(),
    );
    await ctx.h.obsDb
      .updateTable("database_dumps")
      .set({ source: "INSTANCE" })
      .where("id", "=", dumpId)
      .execute();
    await expect(
      a.startRestoreDump({ dumpId, targetTenant: NEW, mode: "fresh", jobs: 4 }),
    ).rejects.toThrow(/switch-over dump/);
  });

  it("archive: needs the target's data volume and no running app; checks the checksum in the Job", async () => {
    const archiveId = await readyArchive();
    const a = adapter();
    await expect(
      a.startRestoreArchive({ archiveId, targetTenant: OLD, pvc: "p" }),
    ).rejects.toThrow(/another tenant/);
    ctx.fake.pvcs.set(NEW, "powerhouse-new-app-data");
    ctx.fake.deployments.set(NEW, { app: 1 });
    await expect(
      a.startRestoreArchive({
        archiveId,
        targetTenant: NEW,
        pvc: "powerhouse-new-app-data",
      }),
    ).rejects.toBeInstanceOf(SwitchoverBackupsUnavailableError);
    ctx.fake.deployments.set(NEW, { app: 0 });
    await expect(
      a.startRestoreArchive({ archiveId, targetTenant: NEW, pvc: "other-pvc" }),
    ).rejects.toBeInstanceOf(SwitchoverBackupsUnavailableError);
    const { restoreId } = await a.startRestoreArchive({
      archiveId,
      targetTenant: NEW,
      pvc: "powerhouse-new-app-data",
    });
    expect(restoreId).toBe(`${NEW}/datarestore-${archiveId}`);
    const job = ctx.fake.jobs.get(`datarestore-${archiveId}`)!;
    expect(job.ns).toBe(NEW);
    const env = Object.fromEntries(
      job.job.spec!.template.spec!.containers[0].env!.map((e) => [
        e.name,
        e.value,
      ]),
    );
    expect(env).toMatchObject({
      S3_KEY: keys.archive,
      ARCHIVE_SHA256: "a".repeat(64),
    });
    expect(
      job.job.spec!.template.spec!.volumes![0].persistentVolumeClaim,
    ).toMatchObject({
      claimName: "powerhouse-new-app-data",
      readOnly: false,
    });
  });

  it("restoreStatus: running, ready, failed (last log line), and a missing Job fails closed", async () => {
    const dumpId = await readyDump();
    const a = adapter();
    const { restoreId } = await a.startRestoreDump({
      dumpId,
      targetTenant: NEW,
      mode: "fresh",
      jobs: 2,
    });
    expect((await a.restoreStatus(restoreId)).status).toBe("RUNNING");
    ctx.fake.finish(
      "pgfresh-",
      false,
      "pg_restore: error: boom\nthe target database is not empty (3 relations): refusing to restore",
    );
    const failed = await a.restoreStatus(restoreId);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain("not empty");
    await a.startRestoreDump({
      dumpId,
      targetTenant: NEW,
      mode: "fresh",
      jobs: 2,
      attempt: 1,
    });
    ctx.fake.finish("pgfresh-");
    expect((await a.restoreStatus(`${NEW}/pgfresh-${dumpId}-1`)).status).toBe(
      "READY",
    );
    expect(await a.restoreStatus(`${NEW}/pgfresh-gone`)).toMatchObject({
      status: "FAILED",
      error: expect.stringContaining("unknown"),
    });
  });
});

/** A ustar archive of regular files, optionally with a GNU long-name entry. */
function tar(
  entries: Array<{ name: string; data: Buffer; type?: string }>,
): Buffer {
  const out: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(type, 156);
    h.write("ustar\0" + "00", 257);
    return h;
  };
  const pad = (b: Buffer) =>
    Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    if (e.name.length > 100) {
      const longName = Buffer.from(e.name + "\0");
      out.push(header("././@LongLink", longName.length, "L"), pad(longName));
    }
    out.push(header(e.name, e.data.length, e.type ?? "0"), pad(e.data));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}
const KEY1 = "1".repeat(64);
const KEY2 = "2".repeat(64);
const archiveBytes = (extra: Array<{ name: string; data: Buffer }> = []) =>
  zstdCompressSync(
    tar([
      { name: "./", data: Buffer.alloc(0), type: "5" },
      { name: "./.ph/run", data: Buffer.from("x".repeat(3000)) },
      ...extra,
      { name: "./workflows-master-key", data: Buffer.from(KEY1) },
      { name: "./attachment-url-signing-secret", data: Buffer.from(KEY2) },
    ]),
  );

describe("reading two files out of an archive in memory", () => {
  const NAMES = ["workflows-master-key", "attachment-url-signing-secret"];

  it("returns exactly the named files", async () => {
    const files = await readFilesFromTarZst(
      Readable.from([archiveBytes()]),
      NAMES,
    );
    expect(files.get("workflows-master-key")!.toString()).toBe(KEY1);
    expect(files.get("attachment-url-signing-secret")!.toString()).toBe(KEY2);
    expect(files.size).toBe(2);
  });

  it("works through the adapter, from chunks, with long names before them", async () => {
    const bytes = archiveBytes([
      { name: "./" + "d/".repeat(80) + "file", data: Buffer.from("zz") },
    ]);
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7)
      chunks.push(bytes.subarray(i, i + 7));
    const a = createSwitchoverBackups({
      backups: {
        ...ctx.h.deps.backups!,
        readObject: async () => Readable.from(chunks),
      },
      observabilityDb: ctx.h.obsDb,
      now: () => new Date(),
    });
    const archiveId = await readyArchive();
    const files = await a.readArchiveFiles(archiveId, NAMES);
    expect(files.get("workflows-master-key")!.toString()).toBe(KEY1);
  });

  it("a missing file is simply absent; a huge one or a damaged archive throws", async () => {
    const some = await readFilesFromTarZst(Readable.from([archiveBytes()]), [
      ...NAMES,
      "nope",
    ]);
    expect(some.has("nope")).toBe(false);
    const big = zstdCompressSync(
      tar([
        {
          name: "./workflows-master-key",
          data: Buffer.alloc(MAX_FILE_BYTES + 1, 65),
        },
      ]),
    );
    await expect(
      readFilesFromTarZst(Readable.from([big]), NAMES),
    ).rejects.toThrow(/too big/);
    await expect(
      readFilesFromTarZst(
        Readable.from([Buffer.from("not zstd at all")]),
        NAMES,
      ),
    ).rejects.toThrow();
  });

  it("refuses a not-ready archive and an adapter without object access", async () => {
    const a = adapter();
    const { archiveId } = await a.startArchive({
      tenant: OLD,
      pvc: "p",
      key: keys.archive,
    });
    await expect(a.readArchiveFiles(archiveId, NAMES)).rejects.toThrow(
      /not ready/,
    );
    const done = await readyArchive();
    const noRead = createSwitchoverBackups({
      backups: { ...ctx.h.deps.backups!, readObject: undefined },
      observabilityDb: ctx.h.obsDb,
      now: () => new Date(),
    });
    await expect(noRead.readArchiveFiles(done, NAMES)).rejects.toBeInstanceOf(
      SwitchoverBackupsUnavailableError,
    );
  });
});

describe("the Job watcher keeps the switch-over key", () => {
  it("a finished dump and archive are READY under switchover/, not the tenant's own prefix", async () => {
    const a = adapter();
    const { dumpId } = await a.startDump({
      tenant: OLD,
      environmentId: "e",
      key: keys.dump,
    });
    await reconcileJob({
      repo: new DumpsRepo(ctx.h.obsDb),
      dumpId,
      jobName: `pgdump-${dumpId}`,
      jobStatus: { succeeded: 1 },
      podPhase: null,
      now: new Date(),
      headSize: async (k) => (k === keys.dump ? 42 : null),
      readPodLogs: async () => "",
    });
    expect(await a.dumpStatus(dumpId)).toMatchObject({
      status: "READY",
      sizeBytes: 42,
    });
    const { archiveId } = await a.startArchive({
      tenant: OLD,
      pvc: "p",
      key: keys.archive,
    });
    await reconcileArchiveJob({
      repo: new ArchivesRepo(ctx.h.obsDb),
      archiveId,
      jobName: `dataarchive-${archiveId}`,
      jobStatus: { succeeded: 1 },
      podPhase: null,
      now: new Date(),
      headSize: async (k) => (k === keys.archive ? 7 : null),
      readPodLogs: async () => `ARCHIVE_SHA256=${"c".repeat(64)}\n`,
    });
    expect(await a.archiveStatus(archiveId)).toMatchObject({
      status: "READY",
      sha256: "c".repeat(64),
      bytes: 7,
    });
  });
});

describe("switch-over objects are not swept or restorable by the owner's paths", () => {
  it("their source is SWITCHOVER, which observability's retention never runs on", async () => {
    const { RETENTION } =
      await import("../../vetra-cloud-observability/dumps/retention.js");
    expect(Object.keys(RETENTION)).not.toContain("SWITCHOVER");
  });
});

// ---- counts ----
const GOOD = JSON.stringify({
  documentsByType: { "b/type": 2, "a/type": 1 },
  operations: 10,
  attachments: 0,
  workflowSecrets: 3,
  keyCheck: "abc",
  contentFingerprint: "cf",
});

describe("parseCounts", () => {
  it("takes the last line, sorted by type", () => {
    expect(parseCounts(`noise\n${GOOD}\n`)).toEqual({
      documentsByType: { "a/type": 1, "b/type": 2 },
      operations: 10,
      attachments: 0,
      workflowSecrets: 3,
      keyCheck: "abc",
      contentFingerprint: "cf",
    });
    expect(parseCounts(GOOD.replace('"abc"', "null")).keyCheck).toBeNull();
  });
  it.each([
    "",
    "garbage",
    "{}",
    '{"documentsByType":[],"operations":1}',
    GOOD.replace("10", "-1"),
    GOOD.replace("10", '"x"'),
  ])("fails on %j", (log) => {
    expect(() => parseCounts(log)).toThrow();
  });
  it("names the first difference by field, never a value", () => {
    const a = parseCounts(GOOD);
    expect(firstCountDifference(a, a)).toBeNull();
    expect(firstCountDifference(a, { ...a, operations: 11 })).toBe(
      "operations",
    );
    expect(
      firstCountDifference(a, { ...a, operations: 11 }, { operations: false }),
    ).toBeNull();
    expect(
      firstCountDifference(a, {
        ...a,
        documentsByType: { ...a.documentsByType, "a/type": 5 },
      }),
    ).toBe("documents of type a/type");
    expect(firstCountDifference(a, { ...a, contentFingerprint: "other" })).toBe(
      "the operation log's content",
    );
    expect(
      firstCountDifference(
        a,
        { ...a, contentFingerprint: "other" },
        { operations: false },
      ),
    ).toBe("the operation log's content");
    // A migration appended operations: the fingerprints cannot match, and that is fine.
    expect(
      firstCountDifference(
        a,
        { ...a, operations: 12, contentFingerprint: "other" },
        { operations: false },
      ),
    ).toBeNull();
    expect(firstCountDifference(a, { ...a, keyCheck: "zzz" })).toBe(
      "the workflow secrets' key check",
    );
  });
});

describe("the counts Job", () => {
  it("runs in the tenant against the primary, with the chart's DB secret and no S3 credentials", () => {
    const job = buildCountsJob({ tenantNs: "t1", image: "img", runId: "r1" });
    expect(job.metadata).toMatchObject({
      name: "pgcounts-r1",
      namespace: "t1",
      labels: { "vetra.io/kind": "switchover-counts", "vetra.io/run-id": "r1" },
    });
    expect(job.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
    });
    const c = job.spec!.template.spec!.containers[0];
    expect(c.image).toBe("img");
    const env = c.env!;
    expect(env.find((e) => e.name === "PGHOST")?.value).toBe(
      "t1-pg-rw.t1.svc.cluster.local",
    );
    expect(
      env.find((e) => e.name === "PGPASSWORD")?.valueFrom?.secretKeyRef?.name,
    ).toBe("t1-pg-app");
    expect(
      env.some((e) => e.name.startsWith("AWS_") || e.name.startsWith("S3_")),
    ).toBe(false);
    expect(env.filter((e) => e.value !== undefined).map((e) => e.name)).toEqual(
      ["PGHOST", "PGPORT"],
    );
  });

  it("the runner creates it once and reads its outcome", async () => {
    const created: string[] = [];
    let status: Record<string, unknown> | null = null;
    let logs = "";
    const runner = createCountsRunner({
      image: "img",
      k8s: {
        async createJob(_ns, job) {
          created.push(job.metadata!.name!);
          status = { active: 1 };
          return job.metadata!.name!;
        },
        async readJobStatus() {
          return status;
        },
        async readPodLogsForJob() {
          return logs;
        },
      },
    });
    await runner.start({ tenant: "t", runId: "r" });
    await runner.start({ tenant: "t", runId: "r" });
    expect(created).toEqual(["pgcounts-r"]);
    expect(await runner.result({ tenant: "t", runId: "r" })).toEqual({
      status: "RUNNING",
    });
    status = { succeeded: 1 };
    logs = "oops";
    expect(await runner.result({ tenant: "t", runId: "r" })).toMatchObject({
      status: "FAILED",
    });
    logs = GOOD;
    expect(await runner.result({ tenant: "t", runId: "r" })).toMatchObject({
      status: "READY",
      counts: { operations: 10 },
    });
    status = { failed: 1 };
    logs = "psql: connection refused";
    expect(await runner.result({ tenant: "t", runId: "r" })).toEqual({
      status: "FAILED",
      error: "psql: connection refused",
    });
    status = null;
    expect((await runner.result({ tenant: "t", runId: "x" })).status).toBe(
      "FAILED",
    );
  });
});

describe("the counts script on a database", () => {
  async function run(setup: string): Promise<unknown> {
    const db = new PGlite();
    try {
      await db.exec(setup);
      const results = await db.exec(COUNTS_SQL);
      const rows = results.at(-1)!.rows as Array<Record<string, unknown>>;
      return Object.values(rows[0])[0];
    } finally {
      await db.close();
    }
  }
  const REACTOR = `
    create schema reactor;
    create table reactor."DocumentSnapshot" ("documentType" text, scope text, "isDeleted" boolean);
    insert into reactor."DocumentSnapshot" values
      ('a/type','global',false),('a/type','global',false),('b/type','global',false),
      ('b/type','global',true),('a/type','local',false);
    create table reactor."Operation" (id int, "documentId" text, scope text, branch text, "index" int);
    insert into reactor."Operation" select g, 'd' || (g % 2), 'global', 'main', g / 2 from generate_series(1, 7) g;`;

  it("a fresh tenant: documents and operations only; the optional tables count 0", async () => {
    expect(await run(REACTOR)).toEqual({
      documentsByType: { "a/type": 2, "b/type": 1 },
      operations: 7,
      attachments: 0,
      workflowSecrets: 0,
      keyCheck: null,
      contentFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("the content fingerprint tells equal counts with other content apart, and is stable", async () => {
    const fp = async (setup: string) =>
      (
        (await run(setup)) as { contentFingerprint: string; operations: number }
      ).contentFingerprint;
    const base = await fp(REACTOR);
    expect(await fp(REACTOR)).toBe(base);
    // Same number of operations, one other id (a partial or swapped copy).
    expect(
      await fp(`${REACTOR} update reactor."Operation" set id = 99 where id = 7;`),
    ).not.toBe(base);
    // Same ids, a document stream one index further.
    expect(
      await fp(`${REACTOR} update reactor."Operation" set "index" = 50 where id = 7;`),
    ).not.toBe(base);
    expect(await fp(`${REACTOR} insert into reactor."Operation" values (8,'d0','global','main',4);`)).not.toBe(base);
  });

  it("finds the workflow secret tables in whatever schema holds secret_key_check", async () => {
    const out = (await run(`${REACTOR}
      create schema attachments; create table attachments.attachment (id int);
      insert into attachments.attachment values (1),(2);
      create schema h4sh; create table h4sh.secret (id int, v text);
      insert into h4sh.secret values (1,'x'),(2,'y'),(3,'z');
      create table h4sh.secret_key_check (fp text); insert into h4sh.secret_key_check values ('k1');`)) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({ attachments: 2, workflowSecrets: 3 });
    expect(typeof out.keyCheck).toBe("string");
    // The key check changes with the check row, and equals for equal content.
    const other = (await run(`${REACTOR}
      create schema h4sh; create table h4sh.secret (id int);
      create table h4sh.secret_key_check (fp text); insert into h4sh.secret_key_check values ('k2');`)) as Record<
      string,
      unknown
    >;
    expect(other.keyCheck).not.toBe(out.keyCheck);
    expect(other.workflowSecrets).toBe(0);
  });
});
