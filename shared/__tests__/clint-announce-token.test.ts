import { describe, expect, it } from 'vitest';
import {
  signClintAnnounceToken,
  verifyClintAnnounceToken,
  loadClintAnnounceSecret,
} from '../clint-announce-token.js';

const SECRET = Buffer.from('a'.repeat(32), 'utf-8');

describe('signClintAnnounceToken', () => {
  it('produces a deterministic 43-char base64url token', () => {
    const t1 = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    const t2 = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(t1).toBe(t2);
    expect(t1).toHaveLength(43);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different tokens for different inputs', () => {
    const a = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    const b = signClintAnnounceToken({ documentId: 'doc-2', prefix: 'a' }, SECRET);
    const c = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'b' }, SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('rejects inputs containing the | separator', () => {
    expect(() =>
      signClintAnnounceToken({ documentId: 'a|b', prefix: 'p' }, SECRET),
    ).toThrow(/separator/i);
    expect(() =>
      signClintAnnounceToken({ documentId: 'd', prefix: 'p|q' }, SECRET),
    ).toThrow(/separator/i);
  });
});

describe('verifyClintAnnounceToken', () => {
  it('verifies a token signed with the same input', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET)).toBe(true);
  });

  it('rejects a token with a different documentId', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-2', prefix: 'ph-pirate' }, SECRET)).toBe(false);
  });

  it('rejects a token with a different prefix', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'b' }, SECRET)).toBe(false);
  });

  it('rejects a token with a different secret', () => {
    const other = Buffer.from('b'.repeat(32), 'utf-8');
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'a' }, other)).toBe(false);
  });

  it('rejects malformed token (length mismatch) without throwing', () => {
    expect(verifyClintAnnounceToken('short', { documentId: 'd', prefix: 'p' }, SECRET)).toBe(false);
    expect(verifyClintAnnounceToken('', { documentId: 'd', prefix: 'p' }, SECRET)).toBe(false);
  });
});

describe('loadClintAnnounceSecret', () => {
  it('decodes the env var as base64', () => {
    const original = process.env.CLINT_ANNOUNCE_SECRET;
    process.env.CLINT_ANNOUNCE_SECRET = Buffer.from('hello').toString('base64');
    try {
      const secret = loadClintAnnounceSecret();
      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.toString('utf-8')).toBe('hello');
    } finally {
      if (original === undefined) delete process.env.CLINT_ANNOUNCE_SECRET;
      else process.env.CLINT_ANNOUNCE_SECRET = original;
    }
  });

  it('throws when the env var is missing', () => {
    const original = process.env.CLINT_ANNOUNCE_SECRET;
    delete process.env.CLINT_ANNOUNCE_SECRET;
    try {
      expect(() => loadClintAnnounceSecret()).toThrow(/CLINT_ANNOUNCE_SECRET/);
    } finally {
      if (original !== undefined) process.env.CLINT_ANNOUNCE_SECRET = original;
    }
  });
});
