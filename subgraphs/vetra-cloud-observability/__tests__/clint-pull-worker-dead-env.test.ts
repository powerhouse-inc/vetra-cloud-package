import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
// @ts-expect-error no bundled types for better-sqlite3
import Database from 'better-sqlite3';
import type { ILogger } from 'document-model';
import { ClintPullWorker } from '../clint-pull-worker.js';

const TICK_MS = 15_000;
const SERVICES = JSON.stringify([{ type: 'CLINT', enabled: true, prefix: 'agent' }]);
const PROVISIONING_SERVICES = JSON.stringify([
  { type: 'CLINT', enabled: true, prefix: 'agent', status: 'PROVISIONING' },
]);

async function setupDbs() {
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
  await obsDb.schema
    .createTable('studio_brand')
    .addColumn('documentId', 'text', (col) => col.primaryKey())
    .addColumn('subdomain', 'text')
    .addColumn('name', 'text')
    .addColumn('maxim', 'text')
    .addColumn('concept', 'text')
    .addColumn('updatedAt', 'text')
    .execute();
  const insertEnv = (id: string, status = 'READY', services = SERVICES) =>
    envDb
      .insertInto('environments')
      .values({ id, name: id, subdomain: id, services, status })
      .execute();
  const envIds = async () =>
    (await envDb.selectFrom('environments').select('id').execute()).map(
      (r: { id: string }) => r.id,
    );
  return { envDb, obsDb, insertEnv, envIds };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as ILogger;

/** Agent health per env id; fetches of `/_proxy/routes` are counted per env. */
let agentOk: Record<string, boolean>;
let agentPolls: Record<string, number>;

beforeEach(() => {
  agentOk = {};
  agentPolls = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const id = url.hostname;
    if (url.pathname === '/_proxy/routes') {
      agentPolls[id] = (agentPolls[id] ?? 0) + 1;
      if (!agentOk[id]) return new Response(null, { status: 502 });
      return Response.json([{ prefix: '/', upstream: 'http://localhost:3000/' }]);
    }
    return new Response(null, { status: 502 }); // brand pull: irrelevant here
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWorker(
  dbs: Awaited<ReturnType<typeof setupDbs>>,
  documentExists: (id: string, signal?: AbortSignal) => Promise<boolean>,
  clock: { now: number },
  extra: { intervalMs?: number } = {},
) {
  return new ClintPullWorker({
    envDb: dbs.envDb,
    obsDb: dbs.obsDb,
    logger,
    buildAgentUrl: (svc) => `http://${svc.documentId}/_proxy/routes`,
    buildBrandUrl: (svc) => `http://${svc.documentId}/switchboard/graphql`,
    documentExists,
    now: () => clock.now,
    ...extra,
  });
}

/** Run `n` ticks, 15 s apart on the injected clock. */
async function runTicks(worker: ClintPullWorker, clock: { now: number }, n: number) {
  for (let i = 0; i < n; i++) {
    await worker.tickOnce();
    clock.now += TICK_MS;
  }
}

describe('ClintPullWorker: dead and failing environments', () => {
  it('removes the record of a deleted environment after 3 failed polls', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('gone');
    await dbs.insertEnv('alive');
    agentOk.alive = true;
    const documentExists = vi.fn(async (id: string) => id !== 'gone');
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    await runTicks(worker, clock, 2);
    expect(documentExists).not.toHaveBeenCalled();
    expect(await dbs.envIds()).toContain('gone');

    await runTicks(worker, clock, 1);
    expect(documentExists).toHaveBeenCalledWith('gone', expect.any(AbortSignal));
    expect(await dbs.envIds()).toEqual(['alive']);

    // Stopped polling it.
    await runTicks(worker, clock, 10);
    expect(agentPolls.gone).toBe(3);
    expect(agentPolls.alive).toBe(13);
  });

  it('backs off polling a failing existing environment', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('flaky');
    const documentExists = vi.fn(async () => true);
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    // 41 ticks = 0 s … 600 s. Polls at 0, 15, 30 (3 failures), then one per 5 min: 330.
    await runTicks(worker, clock, 41);
    expect(agentPolls.flaky).toBe(4);
    expect(await dbs.envIds()).toEqual(['flaky']);

    // Recovers: the next allowed poll (630 s) succeeds, then it's every 15 s again.
    agentOk.flaky = true;
    await runTicks(worker, clock, 2); // 615 (skipped), 630 (poll, ok)
    expect(agentPolls.flaky).toBe(5);
    await runTicks(worker, clock, 4);
    expect(agentPolls.flaky).toBe(9);
  });

  it('keeps the record when the existence check itself fails', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('unknown');
    const documentExists = vi.fn(async () => {
      throw new Error('reactor unavailable');
    });
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    await runTicks(worker, clock, 3);
    expect(documentExists).toHaveBeenCalledTimes(1);
    expect(await dbs.envIds()).toEqual(['unknown']);
    await runTicks(worker, clock, 5);
    expect(agentPolls.unknown).toBe(3); // backed off
  });

  it('keeps polling healthy environments every 15s', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('healthy');
    agentOk.healthy = true;
    const documentExists = vi.fn(async () => true);
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    await runTicks(worker, clock, 9); // 2 minutes
    expect(agentPolls.healthy).toBe(9);
    expect(documentExists).not.toHaveBeenCalled();
  });

  it('keeps polling a PROVISIONING studio every 15s for its first 20 failures', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('coming', 'READY', PROVISIONING_SERVICES);
    const documentExists = vi.fn(async () => true);
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    await runTicks(worker, clock, 20); // 0 s … 285 s
    expect(agentPolls.coming).toBe(20);
    // The existence check still runs at the 3rd failure (30 s).
    expect(documentExists).toHaveBeenCalledTimes(1);
  });

  it('backs off a PROVISIONING studio failing 21 times', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('stuck', 'READY', PROVISIONING_SERVICES);
    const documentExists = vi.fn(async () => true);
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, documentExists, clock);

    // 20 failures at 15 s (0 … 285 s), then the exemption ends: the 21st poll
    // waits 5 min (585 s), the 22nd another 5 min (885 s).
    await runTicks(worker, clock, 39); // 0 … 570 s
    expect(agentPolls.stuck).toBe(20);
    await runTicks(worker, clock, 1); // 585 s
    expect(agentPolls.stuck).toBe(21);
    await runTicks(worker, clock, 20); // 600 … 885 s
    expect(agentPolls.stuck).toBe(22);
    expect(await dbs.envIds()).toEqual(['stuck']);
  });

  it('keeps polling an environment pending a deploy every 15s', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('pushed', 'CHANGES_PUSHED');
    await dbs.insertEnv('deploying', 'DEPLOYING');
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, vi.fn(async () => true), clock);

    await runTicks(worker, clock, 8);
    expect(agentPolls.pushed).toBe(8);
    expect(agentPolls.deploying).toBe(8);
  });

  it('removes a deleted environment even while it is PROVISIONING, logging at error', async () => {
    const dbs = await setupDbs();
    await dbs.insertEnv('gone', 'READY', PROVISIONING_SERVICES);
    const clock = { now: 1_000_000 };
    const worker = makeWorker(dbs, vi.fn(async () => false), clock);
    vi.mocked(logger.error).mockClear();

    await runTicks(worker, clock, 3);
    expect(await dbs.envIds()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('gone environment document no longer exists'));
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the record when the existence check times out after 5s', async () => {
      const dbs = await setupDbs();
      await dbs.insertEnv('slow');
      let aborted = false;
      const documentExists = vi.fn(
        (_id: string, signal?: AbortSignal) =>
          new Promise<boolean>(() => {
            signal?.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      );
      const clock = { now: 1_000_000 };
      const worker = makeWorker(dbs, documentExists, clock);
      await runTicks(worker, clock, 2);

      const third = worker.tickOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await third;
      expect(aborted).toBe(true);
      expect(await dbs.envIds()).toEqual(['slow']);
    });

    it('skips a tick while the previous one is still running', async () => {
      const dbs = await setupDbs();
      await dbs.insertEnv('hung');
      let release: (r: Response) => void = () => {};
      vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
        if (new URL(String(input)).pathname !== '/_proxy/routes') {
          return new Response(null, { status: 502 });
        }
        agentPolls.hung = (agentPolls.hung ?? 0) + 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      const clock = { now: 1_000_000 };
      const worker = makeWorker(dbs, vi.fn(async () => true), clock, { intervalMs: TICK_MS });

      worker.start();
      await vi.advanceTimersByTimeAsync(TICK_MS * 3);
      expect(agentPolls.hung).toBe(1);

      release(Response.json([]));
      await vi.advanceTimersByTimeAsync(TICK_MS);
      expect(agentPolls.hung).toBe(2);
      worker.stop();
    });
  });
});
