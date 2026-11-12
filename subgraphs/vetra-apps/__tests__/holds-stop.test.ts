import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableService } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { makeHarness, OWNER, type Harness } from "./harness.js";
import {
  createEnvironmentStopper,
  databaseBacked,
  stopKeepsDatabase,
} from "../holds/stop.js";
import { getHold, insertHold } from "../holds/repo.js";

describe("VETRA_STOP_KEEPS_DATABASE", () => {
  it("is off unless switched on", () => {
    expect(stopKeepsDatabase({})).toBe(false);
    expect(stopKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: "" })).toBe(false);
    expect(stopKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: "maybe" })).toBe(false);
    expect(stopKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: "off" })).toBe(false);
    for (const v of ["on", "true", "1", "yes", " On "])
      expect(stopKeepsDatabase({ VETRA_STOP_KEEPS_DATABASE: v })).toBe(true);
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

  it("knows which environments carry a database", async () => {
    const sb = await switchboardEnv();
    const clint = await clintOnlyEnv();
    expect(databaseBacked((await h.envs.getState(sb))!)).toBe(true);
    expect(databaseBacked((await h.envs.getState(clint))!)).toBe(false);
  });
});
