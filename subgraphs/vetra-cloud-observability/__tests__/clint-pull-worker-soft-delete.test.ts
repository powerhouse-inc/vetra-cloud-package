import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, SqliteDialect } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
// @ts-expect-error no bundled types for better-sqlite3
import Database from 'better-sqlite3';
import { REACTOR_SCHEMA, runMigrations } from '@powerhousedao/reactor';
import type { ILogger } from 'document-model';
import { ClintPullWorker } from '../clint-pull-worker.js';
import {
  environmentDocumentExists,
  reactorSnapshotMarkedDeleted,
  type EnvExistenceClient,
} from '../env-existence.js';

/**
 * The deletion evidence is queried against a real reactor schema: PGlite with
 * the reactor's own migrations (REACTOR_SCHEMA), so the table/column names are
 * the ones the reactor writes.
 */
const TICK_MS = 15_000;
const SERVICES = JSON.stringify([{ type: 'CLINT', enabled: true, prefix: 'agent' }]);

async function envDbWith(ids: string[]) {
  const envDb = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await envDb.schema
    .createTable('environments')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text')
    .addColumn('subdomain', 'text')
    .addColumn('tenantId', 'text')
    .addColumn('services', 'text')
    .addColumn('status', 'text')
    .execute();
  for (const id of ids) {
    await envDb
      .insertInto('environments')
      .values({ id, name: id, subdomain: id, services: SERVICES, status: 'READY' })
      .execute();
  }
  const obsDb = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await obsDb.schema
    .createTable('clint_runtime_endpoints')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('documentId', 'text')
    .addColumn('prefix', 'text')
    .addColumn('endpointId', 'text')
    .addColumn('type', 'text')
    .addColumn('port', 'text')
    .addColumn('status', 'text')
    .addColumn('lastSeen', 'text')
    .execute();
  const envIds = async () =>
    (await envDb.selectFrom('environments').select('id').execute()).map(
      (r: { id: string }) => r.id,
    );
  return { envDb, obsDb, envIds };
}

async function insertSnapshot(reactorDb: Kysely<any>, documentId: string, isDeleted: boolean) {
  await reactorDb
    .withSchema(REACTOR_SCHEMA)
    .insertInto('DocumentSnapshot')
    .values({
      id: `${documentId}-document`,
      documentId,
      scope: 'document',
      branch: 'main',
      content: JSON.stringify({}),
      documentType: 'powerhouse/vetra-cloud-environment',
      lastOperationIndex: 1,
      lastOperationHash: 'h',
      isDeleted,
    })
    .execute();
}

/** What the vetra tenant's client answers for a soft-deleted env: stream taken, get() not found. */
const softDeletedClient = {
  isDocumentIdTaken: vi.fn(async () => true),
  get: vi.fn(async (id: string) => {
    throw new Error(`Document not found: ${id}`);
  }),
} as unknown as EnvExistenceClient;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ILogger;

/** The reactor's own migrations (it bundles its own kysely version, hence the cast). */
const migrateReactor = (db: Kysely<any>) =>
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0], REACTOR_SCHEMA);

let pg: Kysely<any>;
beforeEach(() => {
  pg = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 502 }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await pg.destroy();
});

function worker(
  dbs: Awaited<ReturnType<typeof envDbWith>>,
  reactorDb: Kysely<any>,
  clock: { now: number },
) {
  return new ClintPullWorker({
    envDb: dbs.envDb,
    obsDb: dbs.obsDb,
    logger,
    buildAgentUrl: (svc) => `http://${svc.documentId}/_proxy/routes`,
    now: () => clock.now,
    documentExists: (id, signal) =>
      environmentDocumentExists(softDeletedClient, id, signal, {
        isMarkedDeleted: (docId) => reactorSnapshotMarkedDeleted(reactorDb, docId),
      }),
  });
}

async function ticks(w: ClintPullWorker, clock: { now: number }, n: number) {
  for (let i = 0; i < n; i++) {
    await w.tickOnce();
    clock.now += TICK_MS;
  }
}

describe('soft-deleted environments (real reactor schema on PGlite)', () => {
  it('removes the record when the snapshot is marked deleted (stream taken, get() not found)', async () => {
    await migrateReactor(pg);
    await insertSnapshot(pg, 'deleted', true);
    await insertSnapshot(pg, 'gap', false);
    const dbs = await envDbWith(['deleted', 'gap']);
    const clock = { now: 1_000_000 };
    await ticks(worker(dbs, pg, clock), clock, 3);
    // 'gap': stream taken, live snapshot row but get() failing → ambiguous, kept.
    expect(await dbs.envIds()).toEqual(['gap']);
  });

  it('keeps the record when the deletion query throws', async () => {
    // No reactor migrations: the query fails with a real "relation does not exist".
    await expect(reactorSnapshotMarkedDeleted(pg, 'deleted')).rejects.toThrow();
    const dbs = await envDbWith(['deleted']);
    const clock = { now: 1_000_000 };
    await ticks(worker(dbs, pg, clock), clock, 3);
    expect(await dbs.envIds()).toEqual(['deleted']);
  });

  it('reads only accepted deletions as evidence', async () => {
    await migrateReactor(pg);
    await insertSnapshot(pg, 'live', false);
    await insertSnapshot(pg, 'deleted', true);
    expect(await reactorSnapshotMarkedDeleted(pg, 'live')).toBe(false);
    expect(await reactorSnapshotMarkedDeleted(pg, 'missing')).toBe(false);
    expect(await reactorSnapshotMarkedDeleted(pg, 'deleted')).toBe(true);
  });
});
