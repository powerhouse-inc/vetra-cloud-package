import { describe, expect, it } from "vitest";
import type { AppRollouts, EnvironmentUpdates } from "../db/schema.js";
import {
  decideRelease,
  ENVIRONMENT_ENDED,
  strandedError,
  type GateInput,
} from "../release-gate.js";

const NOW = "2026-11-10T12:00:00.000Z";
const BEFORE = "2026-11-10T11:00:00.000Z";
const LATER = "2026-11-13T12:00:00.000Z";
const MOVE = {
  artifactName: "host",
  from: "1.0.0",
  to: "1.1.0",
  stranded: false,
};
const STRANDED = {
  artifactName: "host",
  from: "sha-aaaaaaaaaaaa",
  to: "sha-bbbbbbbbbbbb",
  stranded: true,
};

const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1",
  app_id: "a",
  artifact_name: "host",
  version: "1.1.0",
  status: "ACTIVE",
  apply_after: LATER,
  promoted_by: "0xp",
  promoted_at: BEFORE,
  paused_at: null,
  paused_reason: null,
  ...over,
});
const row = (over: Partial<EnvironmentUpdates> = {}): EnvironmentUpdates => ({
  id: "u1",
  rollout_id: "r1",
  environment_id: "e1",
  app_id: "a",
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "PENDING",
  due_at: LATER,
  requested_at: null,
  started_at: null,
  finished_at: null,
  pre_update_dump_id: null,
  error: null,
  forced_at: null,
  created_at: BEFORE,
  ...over,
});
const gate = (over: Partial<GateInput> = {}) =>
  decideRelease({
    policy: "GATED",
    canary: false,
    move: MOVE,
    rollout: rollout(),
    existing: null,
    open: null,
    otherApplying: false,
    environmentId: "e1",
    appId: "a",
    newId: "new",
    now: NOW,
    ...over,
  });
const inserted = (d: ReturnType<typeof gate>) =>
  d.writes.find((w) => w.kind === "insert")?.row;

describe("decideRelease: AUTO keeps today's behaviour", () => {
  it("moves at once and records the update APPLYING, with no rollout", () => {
    const d = gate({ policy: "AUTO", rollout: null });
    expect(d).toMatchObject({
      version: "floor",
      updateId: "new",
      reason: null,
    });
    expect(inserted(d)).toMatchObject({
      id: "new",
      rollout_id: null,
      status: "APPLYING",
      started_at: NOW,
      due_at: NOW,
      from_version: "1.0.0",
      to_version: "1.1.0",
      error: null,
    });
  });

  it("ignores another environment applying and moves on from an older update still applying", () => {
    const d = gate({
      policy: "AUTO",
      rollout: null,
      otherApplying: true,
      open: row({
        id: "old",
        to_version: "1.0.5",
        status: "APPLYING",
        rollout_id: null,
      }),
    });
    expect(d.version).toBe("floor");
    expect(d.writes.map((w) => w.kind)).toStrictEqual(["supersede", "insert"]);
  });

  it("re-attempts after a settled update, and leaves one in flight to the tracker", () => {
    expect(
      inserted(
        gate({
          policy: "AUTO",
          rollout: null,
          existing: row({ status: "FAILED", rollout_id: null }),
        }),
      )?.status,
    ).toBe("APPLYING");
    expect(
      gate({
        policy: "AUTO",
        rollout: null,
        existing: row({ status: "APPLYING", rollout_id: null }),
      }),
    ).toStrictEqual({
      version: "floor",
      updateId: "u1",
      writes: [],
      reason: null,
    });
  });
  it("moves a forced update while another environment of the app is applying", () => {
    const d = gate({
      policy: "AUTO",
      rollout: null,
      move: STRANDED,
      otherApplying: true,
      existing: row({
        rollout_id: null,
        to_version: STRANDED.to,
        forced_at: NOW,
        requested_at: NOW,
      }),
    });
    expect(d).toMatchObject({
      version: "force",
      updateId: "u1",
      writes: [{ kind: "start", id: "u1" }],
    });
  });
});

describe("decideRelease: a stranded version waits for the publisher (both policies)", () => {
  it("holds and records the update PENDING with the error", () => {
    const d = gate({ policy: "AUTO", rollout: null, move: STRANDED });
    expect(d.version).toBe("hold");
    expect(inserted(d)).toMatchObject({
      status: "PENDING",
      started_at: null,
      error: strandedError(STRANDED),
    });
  });

  it("notes the error once on an existing update, not again", () => {
    const fresh = gate({
      policy: "AUTO",
      rollout: null,
      move: STRANDED,
      existing: row({ rollout_id: null, to_version: STRANDED.to }),
    });
    expect(fresh.writes).toStrictEqual([
      { kind: "note", id: "u1", error: strandedError(STRANDED) },
    ]);
    const noted = gate({
      policy: "AUTO",
      rollout: null,
      move: STRANDED,
      existing: row({
        rollout_id: null,
        to_version: STRANDED.to,
        error: strandedError(STRANDED),
      }),
    });
    expect(noted.writes).toStrictEqual([]);
  });

  it("forces a forced one, past the hold", () => {
    const d = gate({
      move: STRANDED,
      existing: row({
        to_version: STRANDED.to,
        forced_at: NOW,
        requested_at: NOW,
      }),
    });
    expect(d).toMatchObject({
      version: "force",
      updateId: "u1",
      writes: [{ kind: "start", id: "u1" }],
    });
  });
});

describe("decideRelease: GATED customers", () => {
  it("holds a version that was never promoted, writing nothing", () => {
    expect(gate({ rollout: null })).toStrictEqual({
      version: "hold",
      updateId: null,
      writes: [],
      reason: "1.1.0 has not been promoted",
    });
  });

  it("creates a PENDING update due at the end of the notice period", () => {
    const d = gate();
    expect(d).toMatchObject({ version: "hold", reason: `due at ${LATER}` });
    expect(inserted(d)).toMatchObject({
      rollout_id: "r1",
      status: "PENDING",
      due_at: LATER,
      started_at: null,
    });
  });

  it("supersedes a PENDING update of an older version and keeps its earlier deadline", () => {
    const d = gate({
      open: row({
        id: "older",
        rollout_id: "r0",
        to_version: "1.0.5",
        due_at: BEFORE,
      }),
    });
    expect(d.writes[0]).toStrictEqual({ kind: "supersede", id: "older" });
    // The earlier deadline has passed: due, so it starts at once.
    expect(inserted(d)).toMatchObject({ due_at: BEFORE, status: "APPLYING" });
    expect(d.version).toBe("floor");
  });

  it("keeps the superseded deadline while it is still ahead, or the rollout's when that is earlier", () => {
    const MID = "2026-11-11T12:00:00.000Z";
    const FAR = "2026-11-20T12:00:00.000Z";
    const keeps = gate({
      open: row({
        id: "older",
        rollout_id: "r0",
        to_version: "1.0.5",
        due_at: MID,
      }),
    });
    expect(keeps.writes[0]).toStrictEqual({ kind: "supersede", id: "older" });
    expect(inserted(keeps)).toMatchObject({ due_at: MID, status: "PENDING" });
    expect(keeps).toMatchObject({ version: "hold", reason: `due at ${MID}` });
    const takes = gate({
      open: row({
        id: "older",
        rollout_id: "r0",
        to_version: "1.0.5",
        due_at: FAR,
      }),
    });
    expect(inserted(takes)).toMatchObject({ due_at: LATER, status: "PENDING" });
  });

  it("starts an update when it is due, or when the holder asked", () => {
    expect(gate({ existing: row({ due_at: BEFORE }) })).toMatchObject({
      version: "floor",
      updateId: "u1",
      writes: [{ kind: "start", id: "u1" }],
    });
    expect(gate({ existing: row({ requested_at: NOW }) })).toMatchObject({
      version: "floor",
      writes: [{ kind: "start", id: "u1" }],
    });
    expect(gate({ existing: row() })).toMatchObject({
      version: "hold",
      writes: [],
      reason: `due at ${LATER}`,
    });
  });

  it("holds while the rollout is paused, unless forced", () => {
    const paused = rollout({ status: "PAUSED" });
    expect(
      gate({ rollout: paused, existing: row({ due_at: BEFORE }) }),
    ).toMatchObject({ version: "hold", reason: "its rollout is paused" });
    expect(
      gate({
        rollout: paused,
        existing: row({ forced_at: NOW, requested_at: NOW }),
      }).version,
    ).toBe("floor");
  });

  it("moves a customer that missed a COMPLETE rollout at once, recording it under that rollout", () => {
    const complete = rollout({ status: "COMPLETE", apply_after: BEFORE });
    const d = gate({ rollout: complete });
    expect(d).toMatchObject({
      version: "floor",
      updateId: "new",
      reason: null,
    });
    expect(inserted(d)).toMatchObject({
      rollout_id: "r1",
      status: "APPLYING",
      due_at: BEFORE,
      started_at: NOW,
    });
    // Still one at a time, and its FAILED update waits for a force.
    expect(gate({ rollout: complete, otherApplying: true })).toMatchObject({
      version: "hold",
      reason: "another environment of the app is updating",
    });
    expect(
      gate({
        rollout: complete,
        existing: row({ status: "FAILED", due_at: BEFORE }),
      }),
    ).toMatchObject({
      version: "hold",
      reason: "its update to 1.1.0 is FAILED",
    });
  });

  it("holds an update the holder asked for while the rollout is paused", () => {
    expect(
      gate({
        rollout: rollout({ status: "PAUSED" }),
        existing: row({ requested_at: NOW }),
      }),
    ).toStrictEqual({
      version: "hold",
      updateId: null,
      writes: [],
      reason: "its rollout is paused",
    });
  });

  it("names the pause, not the deadline, when a paused update is not yet due", () => {
    expect(
      gate({ rollout: rollout({ status: "PAUSED" }), existing: row() }),
    ).toMatchObject({ version: "hold", reason: "its rollout is paused" });
  });

  it("holds while another environment of the app is updating, even forced", () => {
    expect(
      gate({ otherApplying: true, existing: row({ due_at: BEFORE }) }),
    ).toMatchObject({
      version: "hold",
      reason: "another environment of the app is updating",
    });
    expect(
      gate({ otherApplying: true, existing: row({ forced_at: NOW }) }).version,
    ).toBe("hold");
  });

  it("holds while its own earlier update is still applying", () => {
    expect(
      gate({
        open: row({ id: "older", to_version: "1.0.5", status: "APPLYING" }),
        existing: row({ due_at: BEFORE }),
      }),
    ).toMatchObject({
      version: "hold",
      writes: [],
      reason: "its update to 1.0.5 is still applying",
    });
  });

  it("leaves an update in flight to the tracker on a later tick, starting nothing", () => {
    expect(
      gate({ existing: row({ status: "APPLYING", started_at: BEFORE }) }),
    ).toStrictEqual({
      version: "floor",
      updateId: "u1",
      writes: [],
      reason: null,
    });
  });

  it("holds a SUCCEEDED or SUPERSEDED update, writing nothing", () => {
    for (const status of ["SUCCEEDED", "SUPERSEDED"] as const) {
      const existing = row({ status, due_at: BEFORE });
      expect(gate({ existing })).toStrictEqual({
        version: "hold",
        updateId: null,
        writes: [],
        reason: `its update to 1.1.0 is ${status}`,
      });
    }
  });

  it("revives an update closed because its environment ended, and starts it in the same decision when due", () => {
    const ended = row({
      status: "SUPERSEDED",
      error: ENVIRONMENT_ENDED,
      due_at: BEFORE,
      finished_at: BEFORE,
    });
    expect(gate({ existing: ended })).toStrictEqual({
      version: "floor",
      updateId: "u1",
      writes: [
        { kind: "revive", id: "u1" },
        { kind: "start", id: "u1" },
      ],
      reason: null,
    });
    // Not due yet: revived, and waits out its deadline.
    expect(gate({ existing: { ...ended, due_at: LATER } })).toStrictEqual({
      version: "hold",
      updateId: null,
      writes: [{ kind: "revive", id: "u1" }],
      reason: `due at ${LATER}`,
    });
    // Due, but another environment is updating: revived, then waits.
    expect(gate({ existing: ended, otherApplying: true })).toMatchObject({
      version: "hold",
      writes: [{ kind: "revive", id: "u1" }],
      reason: "another environment of the app is updating",
    });
  });

  it("holds any other SUPERSEDED update, writing nothing", () => {
    expect(
      gate({
        existing: row({
          status: "SUPERSEDED",
          error: "no longer a canary",
          due_at: BEFORE,
        }),
      }),
    ).toStrictEqual({
      version: "hold",
      updateId: null,
      writes: [],
      reason: "its update to 1.1.0 is SUPERSEDED",
    });
  });

  it("keeps a FAILED update failed until the rollout is resumed", () => {
    expect(
      gate({ existing: row({ status: "FAILED", due_at: BEFORE }) }),
    ).toMatchObject({
      version: "hold",
      writes: [],
      reason: "its update to 1.1.0 is FAILED",
    });
  });
});

describe("decideRelease: GATED canaries", () => {
  it("need no rollout and are due at once", () => {
    const d = gate({ canary: true, rollout: null });
    expect(d).toMatchObject({ version: "floor", updateId: "new" });
    expect(inserted(d)).toMatchObject({
      rollout_id: null,
      status: "APPLYING",
      due_at: NOW,
    });
  });

  it("still wait for another environment of the app", () => {
    const d = gate({ canary: true, rollout: null, otherApplying: true });
    expect(d.version).toBe("hold");
    expect(inserted(d)).toMatchObject({ status: "PENDING", due_at: NOW });
    expect(
      gate({
        canary: true,
        rollout: null,
        existing: row({ rollout_id: null, due_at: NOW }),
      }).writes,
    ).toStrictEqual([{ kind: "start", id: "u1" }]);
  });
});

describe("decideRelease: a time it cannot read holds, never releases", () => {
  it("holds an update whose due_at does not parse", () => {
    expect(gate({ existing: row({ due_at: "not a time" }) })).toMatchObject({
      version: "hold",
      writes: [],
      reason: "due at not a time",
    });
  });

  it("holds when now does not parse", () => {
    expect(
      gate({ existing: row({ due_at: BEFORE }), now: "not a time" }),
    ).toMatchObject({ version: "hold", writes: [] });
  });

  it("keeps the superseded deadline it can read, and holds when it can read neither", () => {
    // An unreadable old deadline: the rollout's own, still in the future.
    expect(
      inserted(
        gate({
          open: row({ id: "older", to_version: "1.0.5", due_at: "bad" }),
        }),
      ),
    ).toMatchObject({ due_at: LATER, status: "PENDING" });
    // An unreadable apply_after: the old deadline, which has passed.
    expect(
      inserted(
        gate({
          rollout: rollout({ apply_after: "bad" }),
          open: row({ id: "older", to_version: "1.0.5", due_at: BEFORE }),
        }),
      ),
    ).toMatchObject({ due_at: BEFORE, status: "APPLYING" });
    const neither = gate({
      rollout: rollout({ apply_after: "bad" }),
      open: row({ id: "older", to_version: "1.0.5", due_at: "worse" }),
    });
    expect(neither.version).toBe("hold");
    expect(inserted(neither)).toMatchObject({ status: "PENDING" });
  });

  it("compares times of differing precision and offset as times", () => {
    // Equal instants: due.
    expect(
      gate({
        existing: row({ due_at: "2026-11-10T12:00:00Z" }),
        now: "2026-11-10T12:00:00.000+00:00",
      }).version,
    ).toBe("floor");
    // 13:00+02:00 is 11:00Z: past, though it sorts after NOW as text.
    expect(
      gate({ existing: row({ due_at: "2026-11-10T13:00:00+02:00" }) }).version,
    ).toBe("floor");
    // The earlier of two deadlines by time, not by text.
    expect(
      inserted(
        gate({
          rollout: rollout({ apply_after: "2026-11-13T13:30:00+02:00" }),
          open: row({
            id: "older",
            to_version: "1.0.5",
            due_at: "2026-11-13T12:00:00.000Z",
          }),
        }),
      )?.due_at,
    ).toBe("2026-11-13T13:30:00+02:00");
  });
});
