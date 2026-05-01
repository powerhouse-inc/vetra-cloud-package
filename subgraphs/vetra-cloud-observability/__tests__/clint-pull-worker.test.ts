import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { ClintPullWorker } from '../clint-pull-worker.js';

type ClintEndpointsResponse = {
  endpoints: Array<{ id: string; type: string; port: string; status: string }>;
};

function startMockAgent(response: ClintEndpointsResponse | { status: number }): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ('status' in response) {
        res.statusCode = response.status;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

async function setupDbs(): Promise<{
  envDb: Kysely<any>;
  obsDb: Kysely<any>;
  insertEnv: (row: { id: string; subdomain: string; services: string }) => Promise<void>;
}> {
  const envDb = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await envDb.schema
    .createTable('environments')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('subdomain', 'text')
    .addColumn('services', 'text')
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

  const insertEnv = async (row: { id: string; subdomain: string; services: string }) => {
    await envDb.insertInto('environments').values(row).execute();
  };

  return { envDb, obsDb, insertEnv };
}

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('ClintPullWorker.tickOnce', () => {
  let server: Server | null = null;
  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  it('upserts endpoints fetched from a CLINT agent into clint_runtime_endpoints', async () => {
    const mock = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
        { id: 'agent-mcp', type: 'api-mcp', port: '8080', status: 'enabled' },
      ],
    });
    server = mock.server;

    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });

    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: (svc) => `http://127.0.0.1:${mock.port}/clint/endpoints`,
    });

    await worker.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.endpointId).sort()).toEqual(['agent-graphql', 'agent-mcp']);
    rows.forEach((r: any) => {
      expect(r.prefix).toBe('ph-pirate-wouter');
      expect(r.lastSeen).toBeTruthy();
    });
  });

  it('removes endpoints that disappear from the agent response (replace semantics)', async () => {
    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });

    // First tick: 2 endpoints
    const mockA = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
        { id: 'agent-mcp', type: 'api-mcp', port: '8080', status: 'enabled' },
      ],
    });
    server = mockA.server;
    const worker1 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockA.port}/clint/endpoints`,
    });
    await worker1.tickOnce();
    server.close();
    server = null;

    // Second tick: only 1 endpoint
    const mockB = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
      ],
    });
    server = mockB.server;
    const worker2 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockB.port}/clint/endpoints`,
    });
    await worker2.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows.map((r: any) => r.endpointId)).toEqual(['agent-graphql']);
  });

  it('keeps existing rows untouched when the agent fetch fails (timeout/non-200)', async () => {
    const mock = await startMockAgent({ status: 503 });
    server = mock.server;

    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });
    // Pre-populate stale rows to confirm we don't clobber
    await obsDb
      .insertInto('clint_runtime_endpoints')
      .values({
        id: 'doc-1|ph-pirate-wouter|stale-id',
        documentId: 'doc-1',
        prefix: 'ph-pirate-wouter',
        endpointId: 'stale-id',
        type: 'api-graphql',
        port: '8080',
        status: 'enabled',
        lastSeen: '2026-04-30T00:00:00Z',
      })
      .execute();

    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mock.port}/clint/endpoints`,
    });
    await worker.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows.map((r: any) => r.endpointId)).toEqual(['stale-id']);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/clint-pull-worker.*doc-1.*ph-pirate-wouter.*503/),
    );
  });

  it('skips envs with no enabled CLINT services', async () => {
    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-no-clint',
      subdomain: 'no-clint',
      services: JSON.stringify([{ type: 'CONNECT', enabled: true, prefix: 'connect' }]),
    });
    await insertEnv({
      id: 'doc-disabled',
      subdomain: 'disabled',
      services: JSON.stringify([{ type: 'CLINT', enabled: false, prefix: 'ph-pirate' }]),
    });

    const fetchSpy = vi.fn();
    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: (svc) => {
        fetchSpy(svc);
        return 'http://example.invalid/clint/endpoints';
      },
    });
    await worker.tickOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves worker-written rows when a subsequent tick fails', async () => {
    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });

    // First tick: success — worker writes 2 rows.
    const mockA = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
        { id: 'agent-mcp', type: 'api-mcp', port: '8080', status: 'enabled' },
      ],
    });
    server = mockA.server;
    const worker1 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockA.port}/clint/endpoints`,
    });
    await worker1.tickOnce();
    const initialRows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(initialRows).toHaveLength(2);
    const initialLastSeen = (initialRows[0] as any).lastSeen as string;
    server.close();
    server = null;

    // Second tick: 503 — rows must survive untouched.
    const mockB = await startMockAgent({ status: 503 });
    server = mockB.server;
    const worker2 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockB.port}/clint/endpoints`,
    });
    await worker2.tickOnce();

    const rowsAfterFailure = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rowsAfterFailure).toHaveLength(2);
    expect(rowsAfterFailure.map((r: any) => r.endpointId).sort()).toEqual([
      'agent-graphql',
      'agent-mcp',
    ]);
    rowsAfterFailure.forEach((r: any) => {
      expect(r.lastSeen).toBe(initialLastSeen);
    });
  });
});
