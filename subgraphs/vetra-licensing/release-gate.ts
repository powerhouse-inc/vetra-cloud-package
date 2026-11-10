import type {
  AppRollouts,
  EnvironmentUpdates,
  ReleasePolicy,
} from "./db/schema.js";
import type { FusionMove, FusionVersionMode } from "./template.js";

/** Everything the gate decides from; the update-gate reads it under one transaction. */
export interface GateInput {
  policy: ReleasePolicy;
  /** The environment resolves on a channel override (a canary): no rollout gates it. */
  canary: boolean;
  move: FusionMove;
  /** GATED, not a canary: the ACTIVE or PAUSED rollout of move.to; null when it was never promoted. */
  rollout: AppRollouts | null;
  /**
   * This environment's row for this move: its row of `rollout`, or (canary,
   * AUTO) its newest row without a rollout to move.to that is not SUPERSEDED.
   */
  existing: EnvironmentUpdates | null;
  /** This environment's newest PENDING or APPLYING row other than `existing`. */
  open: EnvironmentUpdates | null;
  /** Another environment of the same app has an APPLYING update. */
  otherApplying: boolean;
  environmentId: string;
  appId: string;
  /** The id a row inserted by this decision gets. */
  newId: string;
  now: string;
}

export type GateWrite =
  | { kind: "insert"; row: EnvironmentUpdates }
  /** PENDING -> APPLYING, started now. */
  | { kind: "start"; id: string }
  | { kind: "supersede"; id: string }
  /** A PENDING row gets (or changes) its error: logged once, shown as "needs attention". */
  | { kind: "note"; id: string; error: string };

export interface GateDecision {
  version: FusionVersionMode;
  /** The update that is APPLYING for this move when the version is set; null when it is held. */
  updateId: string | null;
  writes: GateWrite[];
  /** Why the version waits; null when it moves. */
  reason: string | null;
}

/** The error a stranded move's update carries (and the keeper logs once per version). */
export function strandedError(move: FusionMove): string {
  return `FUSION ${move.from} is not in the app's record (it keeps the last 50 versions, or it was pinned by hand), so it cannot be proven older than ${move.to}; the publisher can force the update`;
}

// Times fail closed: one that does not parse is never due.
const at = (iso: string): number => Date.parse(iso);
const readable = (iso: string): boolean => !Number.isNaN(at(iso));
const isDue = (due: string, now: string): boolean =>
  readable(due) && readable(now) && at(due) <= at(now);
/** The earlier deadline; one that does not parse loses to one that does. */
const earlier = (a: string, b: string | null): string => {
  if (b === null || !readable(b)) return a;
  if (!readable(a)) return b;
  return at(b) < at(a) ? b : a;
};

/**
 * Pure. May the keeper move this live environment's FUSION version now, and
 * which update rows record that (spec 4.3)?
 *
 * AUTO (the default) always moves, as the floor did before; it only records
 * an update, created APPLYING. GATED moves a customer only when its update is
 * PENDING and due (requested, or past due_at), its rollout ACTIVE and no
 * other update of the app APPLYING; a canary needs no rollout and is due at
 * once. A version the floor cannot order (stranded) waits for the
 * publisher's force under either policy, its update carrying the error. A
 * forced update skips the deadline, the pause and the stranded hold, never
 * the one-at-a-time rule. A new version supersedes a PENDING update of an
 * older one and keeps its earlier deadline (decision 9).
 */
export function decideRelease(i: GateInput): GateDecision {
  const gated = i.policy === "GATED";
  const rolledOut = gated && !i.canary;
  const writes: GateWrite[] = [];
  const hold = (reason: string): GateDecision => ({
    version: "hold",
    updateId: null,
    writes,
    reason,
  });

  if (i.open?.status === "APPLYING") {
    // Gated: one update at a time, so the earlier one settles first.
    if (gated)
      return hold(`its update to ${i.open.to_version} is still applying`);
    // AUTO moves on to the newer version, as the floor always has.
    writes.push({ kind: "supersede", id: i.open.id });
  }
  if (rolledOut && !i.rollout)
    return hold(`${i.move.to} has not been promoted`);

  const existing = i.existing;
  if (existing?.status === "APPLYING") {
    // In flight (a re-send after a crash is harmless): the tracker settles it.
    const version =
      existing.forced_at !== null && i.move.stranded ? "force" : "floor";
    return { version, updateId: existing.id, writes, reason: null };
  }
  if (existing && existing.status !== "PENDING" && gated) {
    // FAILED waits for resumeRollout or a force; anything else is settled.
    return hold(`its update to ${i.move.to} is ${existing.status}`);
  }

  const pending = existing?.status === "PENDING" ? existing : null;
  const forced = pending !== null && pending.forced_at !== null;
  const stranded = i.move.stranded ? strandedError(i.move) : null;
  const openPending = i.open?.status === "PENDING" ? i.open : null;
  const dueAt =
    pending?.due_at ??
    (rolledOut && i.rollout
      ? earlier(i.rollout.apply_after, openPending?.due_at ?? null)
      : i.now);

  let reason: string | null = null;
  if (stranded && !forced) {
    reason = stranded;
  } else if (gated) {
    const requested = pending !== null && pending.requested_at !== null;
    if (rolledOut && !forced && !requested && !isDue(dueAt, i.now))
      reason = `due at ${dueAt}`;
    else if (rolledOut && !forced && i.rollout?.status !== "ACTIVE")
      reason = "its rollout is paused";
    else if (i.otherApplying)
      reason = "another environment of the app is updating";
  }

  if (!pending) {
    if (openPending) writes.push({ kind: "supersede", id: openPending.id });
    writes.push({
      kind: "insert",
      row: {
        id: i.newId,
        rollout_id: rolledOut && i.rollout ? i.rollout.id : null,
        environment_id: i.environmentId,
        app_id: i.appId,
        from_version: i.move.from,
        to_version: i.move.to,
        status: reason ? "PENDING" : "APPLYING",
        due_at: dueAt,
        requested_at: null,
        started_at: reason ? null : i.now,
        finished_at: null,
        pre_update_dump_id: null,
        error: stranded,
        forced_at: null,
        created_at: i.now,
      },
    });
    return reason
      ? hold(reason)
      : { version: "floor", updateId: i.newId, writes, reason: null };
  }
  if (reason) {
    if (stranded && !forced && pending.error !== stranded)
      writes.push({ kind: "note", id: pending.id, error: stranded });
    return hold(reason);
  }
  writes.push({ kind: "start", id: pending.id });
  return {
    version: stranded ? "force" : "floor",
    updateId: pending.id,
    writes,
    reason: null,
  };
}
