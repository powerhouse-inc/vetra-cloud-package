import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableService } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { makeHarness, OWNER, type Harness } from "./harness.js";
import {
  createEnvironmentStopper,
  databaseBacked,
  housekeepingKeepsDatabase,
  offboardingKeepsDatabase,
  runsClint,
} from "../holds/stop.js";
import { getHold, insertHold } from "../holds/repo.js";

describe("VETRA_OFFBOARDING_KEEPS_DATABASE / VETRA_HOUSEKEEPING_KEEPS_DATABASE", () => {
  const cases = [
    ["VETRA_OFFBOARDING_KEEPS_DATABASE", offboardingKeepsDatabase],
    ["VETRA_HOUSEKEEPING_KEEPS_DATABASE", housekeepingKeepsDatabase],
  ] as const;
  for (const [name, read] of cases)
    it(`${name} is off unless switched on`, () => {
      expect(read({})).toBe(false);
      expect(read({ [name]: "" })).toBe(false);
      expect(read({ [name]: "maybe" })).toBe(false);
      expect(read({ [name]: "off" })).toBe(false);
      for (const v of ["on", "true", "1", "yes", " On "])
        expect(read({ [name]: v })).toBe(true);
    });

  it("are separate switches, and the old VETRA_STOP_KEEPS_DATABASE switches neither", () => {
    expect(offboardingKeepsDatabase({ VETRA_HOUSEKEEPING_KEEPS_DATABASE: "on" })).toBe(false);
    expect(housekeepingKeepsDatabase({ VETRA_OFFBOARDING_KEEPS_DATABASE: "on" })).toBe(false);
    expect(offboardingKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: "on" })).toBe(false);
    expect(housekeepingKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: "on" })).toBe(false);
  });
});

describe("environment stopper", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  /** A READY environment with a switchboard (database-backed). */
  const switchboardEnv = async () => {
    const id = await h.envs.seedStandalone();
    h.envs.executed.length = 0;
    return id;
  };
  /** A READY environment that only runs Connect (no database). */
  const clintOnlyEnv = async () => {
    const id = await h.envs.create();
    const { setLabel, initialize, setOwner, approveChanges } = await import(
      "../../../document-models/vetra-cloud-environment/v1/index.js"
    );
    await h.envs.execute(id, [
      setLabel({ label: "connect-only" }),
      initialize({
        genericSubdomain: `sub-${id}`,
        genericBaseDomain: "vetra.io",
        defaultPackageRegistry: "https://registry.vetra.io",
      }),
      setOwner({ address: OWNER }),
      enableService({ type: "CONNECT", prefix: "connect" }),
      approveChanges({}),
    ]);
    h.envs.setStatus(id, "READY");
    h.envs.executed.length = 0;
    return id;
  };
  const types = () => h.envs.executed.flatMap((e) => e.types);

  it("sleeps as before while the switch is off", async () => {
    const id = await switchboardEnv();
    const s = createEnvironmentStopper(h.deps, { keepsDatabase: false, reason: "licence ended" });
    expect(await s.stop(id)).toBe("slept");
    expect(types()).toEqual(["SLEEP_ENVIRONMENT"]);
    expect(await getHold(h.db, id)).toBeNull();
    expect(await s.resume(id)).toBe("woken");
    expect(types()).toContain("WAKE_ENVIRONMENT");
  });

  it("holds a database-backed environment when the switch is on, and releases it on resume", async () => {
    const id = await switchboardEnv();
    const s = createEnvironmentStopper(h.deps, { keepsDatabase: true, reason: "licence ended" });
    expect(await s.stop(id)).toBe("held");
    expect(types()).not.toContain("SLEEP_ENVIRONMENT");
    expect(await getHold(h.db, id)).toMatchObject({ reason: "licence ended" });
    expect(await s.isStopped(id)).toBe(true);
    expect(await s.stop(id)).toBe("held"); // idempotent
    h.envs.executed.length = 0;
    expect(await s.resume(id)).toBe("released");
    expect(types()).not.toContain("WAKE_ENVIRONMENT");
    expect(await getHold(h.db, id)).toBeNull();
    expect(await s.isStopped(id)).toBe(false);
  });

  it("still sleeps an environment without a database (nothing to lose) when the switch is on", async () => {
    const id = await clintOnlyEnv();
    const s = createEnvironmentStopper(h.deps, { keepsDatabase: true, reason: "idle" });
    expect(await s.stop(id)).toBe("slept");
    expect(types()).toEqual(["SLEEP_ENVIRONMENT"]);
  });

  it("never releases a hold it did not make (another reason, or a switch-over's)", async () => {
    const id = await switchboardEnv();
    await insertHold(h.db, {
      environment_id: id,
      reason: "switch-over",
      switchover_id: "sw-1",
      created_by: "vetra",
      created_at: "2026-11-12T00:00:00.000Z",
    });
    const s = createEnvironmentStopper(h.deps, { keepsDatabase: true, reason: "licence ended" });
    expect(await s.isStopped(id)).toBe(false);
    expect(await s.resume(id)).toBe("none");
    expect(await getHold(h.db, id)).not.toBeNull();
  });

  /** A READY database-backed environment that also runs a CLINT agent. */
  const clintSwitchboardEnv = async () => {
    const id = await h.envs.seedStandalone();
    const { approveChanges } = await import(
      "../../../document-models/vetra-cloud-environment/v1/index.js"
    );
    await h.envs.execute(id, [
      enableService({
        type: "CLINT",
        prefix: "agent",
        clintConfig: { package: { registry: "https://r", name: "p" }, env: [] },
      }),
      approveChanges({}),
    ]);
    h.envs.setStatus(id, "READY");
    h.envs.executed.length = 0;
    return id;
  };

  it("sleeps a CLINT environment, database or not, when it may not hold CLINT (the chart cannot scale clint)", async () => {
    const id = await clintSwitchboardEnv();
    expect(runsClint((await h.envs.getState(id))!)).toBe(true);
    const s = createEnvironmentStopper(h.deps, {
      keepsDatabase: true,
      reason: "idle",
      sleepsClint: true,
    });
    expect(await s.stop(id)).toBe("slept");
    expect(types()).toEqual(["SLEEP_ENVIRONMENT"]);
    expect(await getHold(h.db, id)).toBeNull();
  });

  it("still holds a database-backed environment without CLINT when it sleeps CLINT ones", async () => {
    const id = await switchboardEnv();
    expect(runsClint((await h.envs.getState(id))!)).toBe(false);
    const s = createEnvironmentStopper(h.deps, {
      keepsDatabase: true,
      reason: "idle",
      sleepsClint: true,
    });
    expect(await s.stop(id)).toBe("held");
  });

  it("skips an environment already held: no state read, no re-render, never a sleep", async () => {
    const id = await switchboardEnv();
    const s = createEnvironmentStopper(h.deps, { keepsDatabase: true, reason: "licence ended" });
    expect(await s.stop(id)).toBe("held");
    h.envs.executed.length = 0;
    let reads = 0;
    const getState = h.envs.getState.bind(h.envs);
    h.envs.getState = async (envId: string) => {
      reads++;
      return getState(envId);
    };
    expect(await s.stop(id)).toBe("held");
    expect(reads).toBe(0);
    expect(types()).toEqual([]);

    // held by someone else (a switch-over): left as it is, not slept
    const other = await switchboardEnv();
    await insertHold(h.db, {
      environment_id: other,
      reason: "switch-over",
      switchover_id: "sw-1",
      created_by: "vetra",
      created_at: "2026-11-12T00:00:00.000Z",
    });
    expect(await s.stop(other)).toBe("skipped");
    expect(types()).toEqual([]);
    expect(await getHold(h.db, other)).toMatchObject({ switchover_id: "sw-1" });
  });

  it("does not look up holds for isStopped while the switch is off", async () => {
    const id = await switchboardEnv();
    const s = createEnvironmentStopper(
      { ...h.deps, db: new Proxy({}, { get() { throw new Error("db read"); } }) as never },
      { keepsDatabase: false, reason: "licence ended" },
    );
    expect(await s.isStopped(id)).toBe(false);
  });

  it("knows which environments carry a database", async () => {
    const sb = await switchboardEnv();
    const clint = await clintOnlyEnv();
    expect(databaseBacked((await h.envs.getState(sb))!)).toBe(true);
    expect(databaseBacked((await h.envs.getState(clint))!)).toBe(false);
  });
});
