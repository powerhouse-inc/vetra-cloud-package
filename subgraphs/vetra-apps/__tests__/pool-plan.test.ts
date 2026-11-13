import { describe, expect, it } from "vitest";
import type { InstanceStatus } from "../db/schema.js";
import {
  planPool,
  POOL_OFF,
  POOL_STALE,
  POOL_SURPLUS,
  warmInstanceName,
} from "../plans/pool.js";

const row = (
  id: string,
  o: {
    digest?: string;
    size?: string;
    status?: InstanceStatus;
    at?: string;
  } = {},
) => ({
  id,
  status: o.status ?? ("ready" as InstanceStatus),
  target_digest: o.digest ?? "d2",
  running_digest: o.status === "ready" || !o.status ? (o.digest ?? "d2") : null,
  target_size: o.size ?? "VETRA_AGENT_M",
  created_at: o.at ?? `2026-11-12T00:00:0${id.slice(-1)}.000Z`,
});
const want = (size: number, digest: string | null = "d2") => ({
  size,
  digest,
  targetSize: "VETRA_AGENT_M",
});

describe("planPool", () => {
  it("fills one per pass", () => {
    expect(planPool([], want(2))).toEqual({ create: true, remove: [] });
    expect(planPool([row("r1")], want(2))).toEqual({
      create: true,
      remove: [],
    });
    expect(
      planPool([row("r1"), row("r2", { status: "updating" })], want(2)),
    ).toEqual({ create: false, remove: [] });
  });

  it("drains when the pool is off or the plan has no target", () => {
    expect(
      planPool([row("r1"), row("r2")], want(0)).remove.map((r) => r.reason),
    ).toEqual([POOL_OFF, POOL_OFF]);
    expect(planPool([row("r1")], want(1, null))).toEqual({
      create: false,
      remove: [{ id: "r1", reason: POOL_OFF }],
    });
  });

  it("removes surplus: not-ready newest first, then ready oldest first", () => {
    const p = planPool(
      [row("r1"), row("r2"), row("r3", { status: "updating" })],
      want(1),
    );
    expect(p.remove).toEqual([
      { id: "r3", reason: POOL_SURPLUS },
      { id: "r1", reason: POOL_SURPLUS },
    ]);
    expect(p.create).toBe(false);
  });

  it("replaces stale rows rolling: create first, remove a stale one once over size", () => {
    const stale = [row("r1", { digest: "d1" }), row("r2", { digest: "d1" })];
    expect(planPool(stale, want(2))).toEqual({ create: true, remove: [] });
    const next = [...stale, row("r3")];
    expect(planPool(next, want(2))).toEqual({
      create: true,
      remove: [{ id: "r1", reason: POOL_STALE }],
    });
    expect(
      planPool([row("r2", { digest: "d1" }), row("r3"), row("r4")], want(2)),
    ).toEqual({
      create: false,
      remove: [{ id: "r2", reason: POOL_STALE }],
    });
  });

  it("a size change makes rows stale; a failed fresh row keeps its slot", () => {
    expect(planPool([row("r1", { size: "VETRA_AGENT_S" })], want(1))).toEqual({
      create: true,
      remove: [],
    });
    expect(planPool([row("r1", { status: "failed" })], want(1))).toEqual({
      create: false,
      remove: [],
    });
  });

  it("warm names are stable per row and look like own rows", () => {
    expect(warmInstanceName("id-1")).toMatch(/^own-warm-[0-9a-f]{12}$/);
    expect(warmInstanceName("id-1")).toBe(warmInstanceName("id-1"));
  });
});
