import { describe, expect, it } from 'vitest';
import { DEPLOY_STUCK_AFTER_MS, DeployStuckTracker } from '../deploy-health.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-19T10:00:00.000Z');

function env(id: string, status: string, deployingSince: string | null = null) {
  return { id, status, name: id, deployingSince };
}

describe('DeployStuckTracker', () => {
  it('reports a deploy stuck for more than 15 min once per episode', () => {
    const t = new DeployStuckTracker();
    const since = new Date(T0).toISOString();
    expect(t.newlyStuck([env('a', 'DEPLOYING', since)], T0 + 10 * MIN)).toEqual([]);
    expect(t.newlyStuck([env('a', 'DEPLOYING', since)], T0 + DEPLOY_STUCK_AFTER_MS)).toEqual([]);
    const hit = t.newlyStuck([env('a', 'DEPLOYING', since)], T0 + 16 * MIN);
    expect(hit.map((e) => e.id)).toEqual(['a']);
    expect(hit[0].stuckForMs).toBe(16 * MIN);
    // Not again while the same episode lasts.
    expect(t.newlyStuck([env('a', 'DEPLOYING', since)], T0 + 60 * MIN)).toEqual([]);
  });

  it('starts a new episode once the env left the pending set', () => {
    const t = new DeployStuckTracker();
    expect(t.newlyStuck([env('a', 'CHANGES_PUSHED')], T0)).toEqual([]);
    expect(t.newlyStuck([env('a', 'CHANGES_PUSHED')], T0 + 16 * MIN)).toHaveLength(1);
    expect(t.newlyStuck([], T0 + 17 * MIN)).toEqual([]);
    expect(t.newlyStuck([env('a', 'CHANGES_PUSHED')], T0 + 18 * MIN)).toEqual([]);
    expect(t.newlyStuck([env('a', 'CHANGES_PUSHED')], T0 + 34 * MIN)).toHaveLength(1);
  });

  it('keeps the episode across CHANGES_PUSHED → DEPLOYING, restarts on a new deployingSince', () => {
    const t = new DeployStuckTracker();
    expect(t.newlyStuck([env('a', 'CHANGES_PUSHED')], T0)).toEqual([]);
    const s1 = new Date(T0 + 5 * MIN).toISOString();
    expect(t.newlyStuck([env('a', 'DEPLOYING', s1)], T0 + 5 * MIN)).toEqual([]);
    expect(t.newlyStuck([env('a', 'DEPLOYING', s1)], T0 + 16 * MIN)).toHaveLength(1);
    const s2 = new Date(T0 + 20 * MIN).toISOString();
    expect(t.newlyStuck([env('a', 'DEPLOYING', s2)], T0 + 30 * MIN)).toEqual([]);
    expect(t.newlyStuck([env('a', 'DEPLOYING', s2)], T0 + 36 * MIN)).toHaveLength(1);
  });

  it('dates an episode from deployingSince after a restart', () => {
    const t = new DeployStuckTracker();
    const old = new Date(T0 - 60 * MIN).toISOString();
    expect(t.newlyStuck([env('a', 'DEPLOYING', old)], T0)).toHaveLength(1);
  });
});
