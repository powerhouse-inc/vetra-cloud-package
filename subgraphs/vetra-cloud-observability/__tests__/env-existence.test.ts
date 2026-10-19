import { describe, expect, it, vi } from 'vitest';
import {
  environmentDocumentExists,
  type EnvExistenceClient,
} from '../env-existence.js';

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function client(
  taken: boolean | Error,
  get: (() => unknown) | Error,
): EnvExistenceClient {
  return {
    isDocumentIdTaken: vi.fn(async () => {
      if (taken instanceof Error) throw taken;
      return taken;
    }),
    get: vi.fn(async () => {
      if (get instanceof Error) throw get;
      return get();
    }),
  } as unknown as EnvExistenceClient;
}

describe('environmentDocumentExists', () => {
  it('a deleted document is gone (DocumentDeletedError)', async () => {
    const c = client(true, named('DocumentDeletedError', 'Document x has been deleted'));
    expect(await environmentDocumentExists(c, 'x')).toBe(false);
  });

  it('a deleted document is gone (deleted flag on the returned document)', async () => {
    const c = client(true, () => ({ state: { document: { isDeleted: true } } }));
    expect(await environmentDocumentExists(c, 'x')).toBe(false);
  });

  it('no operation stream at all is gone, without reading the snapshot', async () => {
    const c = client(false, () => ({}));
    expect(await environmentDocumentExists(c, 'x')).toBe(false);
    expect(c.get).not.toHaveBeenCalled();
  });

  it('a live stream with a missing snapshot is kept', async () => {
    const c = client(true, new Error('Document not found: x'));
    expect(await environmentDocumentExists(c, 'x')).toBe(true);
  });

  it('a live, readable document is kept', async () => {
    const c = client(true, () => ({ state: { document: {}, global: {} } }));
    expect(await environmentDocumentExists(c, 'x')).toBe(true);
  });

  it('a failing stream lookup throws (the caller keeps the record)', async () => {
    const c = client(new Error('connection reset'), () => ({}));
    await expect(environmentDocumentExists(c, 'x')).rejects.toThrow('connection reset');
  });
});
