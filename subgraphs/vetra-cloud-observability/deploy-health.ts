/**
 * Detects deploys stuck in CHANGES_PUSHED/DEPLOYING for longer than
 * {@link DEPLOY_STUCK_AFTER_MS}, so the deployment reconciler can log each
 * stuck episode once at error level instead of an info line every tick.
 */

/** A deploy pending longer than this is stuck. */
export const DEPLOY_STUCK_AFTER_MS = 15 * 60_000;

export interface PendingEnv {
  id: string;
  status: string;
  name: string | null;
  deployingSince: string | null;
}

type Episode = { since: number; deployingSince: string | null; logged: boolean };

export class DeployStuckTracker {
  private readonly episodes = new Map<string, Episode>();

  /**
   * Feed the envs pending this tick; returns the ones that just crossed the
   * stuck threshold (each episode once). An episode runs while the env stays
   * pending; it ends when the env leaves the pending set, or restarts when its
   * `deployingSince` moves to a new deploy. It starts at `deployingSince` when
   * that is earlier than first sighting (survives a pod restart).
   */
  newlyStuck<T extends PendingEnv>(
    pending: T[],
    nowMs: number,
  ): Array<T & { stuckForMs: number }> {
    const seen = new Set<string>();
    const out: Array<T & { stuckForMs: number }> = [];
    for (const env of pending) {
      seen.add(env.id);
      let ep = this.episodes.get(env.id);
      if (
        !ep ||
        (ep.deployingSince !== null &&
          env.deployingSince !== null &&
          env.deployingSince !== ep.deployingSince)
      ) {
        const started = env.deployingSince ? Date.parse(env.deployingSince) : NaN;
        ep = {
          since: Number.isFinite(started) ? Math.min(started, nowMs) : nowMs,
          deployingSince: env.deployingSince,
          logged: false,
        };
        this.episodes.set(env.id, ep);
      } else if (ep.deployingSince === null && env.deployingSince !== null) {
        ep.deployingSince = env.deployingSince;
      }
      const stuckForMs = nowMs - ep.since;
      if (!ep.logged && stuckForMs > DEPLOY_STUCK_AFTER_MS) {
        ep.logged = true;
        out.push({ ...env, stuckForMs });
      }
    }
    for (const id of this.episodes.keys()) {
      if (!seen.has(id)) this.episodes.delete(id);
    }
    return out;
  }
}
