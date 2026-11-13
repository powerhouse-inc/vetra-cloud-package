import { afterEach, describe, expect, it } from "vitest";
import { listAudit } from "../audit/repo.js";
import { createResolvers } from "../resolvers.js";
import { ADMIN, OWNER, STRANGER } from "./harness.js";
import {
  drive,
  flow,
  HOLDER,
  OLD_HOST,
  type Flow,
} from "./switchover-flow-fixtures.js";

let f: Flow | null = null;
afterEach(async () => {
  await f?.h.close();
  f = null;
});
const HOUR = 3_600_000;

const ctxOf = (address: string) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  isAdmin: (a: string) => a.toLowerCase() === ADMIN,
});
const asAdmin = ctxOf(ADMIN);
const asOwner = ctxOf(OWNER);
const asHolder = ctxOf(HOLDER);
const asStranger = ctxOf(STRANGER);

type Fn = (parent: unknown, args: any, ctx: unknown) => Promise<any>;
const q = (fl: Flow, name: string) =>
  (createResolvers(fl.h.deps).Query as unknown as Record<string, Fn>)[name];
const m = (fl: Flow, name: string) =>
  (createResolvers(fl.h.deps).Mutation as unknown as Record<string, Fn>)[name];
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (
      (e as { extensions?: { code?: string } }).extensions?.code ?? String(e)
    );
  }
};

describe("the switch-over API is for platform admins", () => {
  it("every query and mutation refuses an owner, a holder and a stranger (confirmSwitchover aside)", async () => {
    f = await flow({ frozen: false });
    const at = (h: number) =>
      new Date(f!.h.deps.now().getTime() + h * HOUR).toISOString();
    const calls: Array<[string, Fn, unknown]> = [
      ["switchovers", q(f, "switchovers"), { appId: f.appId }],
      [
        "switchoverChecks",
        q(f, "switchoverChecks"),
        { environmentId: f.oldEnv },
      ],
      [
        "adoptLicensedKind",
        m(f, "adoptLicensedKind"),
        {
          appId: f.appId,
          kind: "x",
          slug: "x",
          name: "X",
          size: "VETRA_AGENT_M",
          targetVersion: "1.4.0",
        },
      ],
      [
        "freezeAppReleases",
        m(f, "freezeAppReleases"),
        { appId: f.appId, reason: "r" },
      ],
      ["unfreezeAppReleases", m(f, "unfreezeAppReleases"), { appId: f.appId }],
      [
        "planSwitchover",
        m(f, "planSwitchover"),
        { environmentId: f.oldEnv, windowStart: at(80), windowEnd: at(82) },
      ],
      [
        "dryRunSwitchover",
        m(f, "dryRunSwitchover"),
        { environmentId: f.oldEnv },
      ],
      ["resumeSwitchover", m(f, "resumeSwitchover"), { id: f.sw.id }],
      ["rollBackSwitchover", m(f, "rollBackSwitchover"), { id: f.sw.id }],
      ["cleanUpDryRun", m(f, "cleanUpDryRun"), { id: f.sw.id }],
    ];
    for (const who of [asOwner, asHolder, asStranger])
      for (const [name, fn, args] of calls)
        expect([name, await code(fn({}, args, who))]).toEqual([
          name,
          "FORBIDDEN",
        ]);
    expect(
      await code(
        q(f, "switchovers")({}, { appId: f.appId }, { user: undefined }),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("an admin reads the App's switch-overs with counts and the checks of an environment", async () => {
    f = await flow();
    await drive(f, "AWAITING_CONFIRMATION");
    const rows = await q(f, "switchovers")({}, { appId: f.appId }, asAdmin);
    expect(rows).toEqual([
      expect.objectContaining({
        id: f.sw.id,
        state: "AWAITING_CONFIRMATION",
        mode: "real",
        oldHost: OLD_HOST,
        releaseVersion: "1.4.0",
        canRollBack: true,
        rollBackLosesWrites: true,
        sourceCounts: expect.stringContaining("operations"),
      }),
    ]);
    // Never a key, a fingerprint, or any content.
    const raw = JSON.stringify(rows);
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
    expect(
      await q(f, "switchoverChecks")({}, { environmentId: "nope" }, asAdmin),
    ).toEqual(["this is not a licensed environment"]);
  });

  it("an admin plans, dry-runs, freezes, rolls back and resumes through the API; errors name why", async () => {
    f = await flow({ frozen: false });
    await f.h.db.deleteFrom("switchovers").execute();
    const at = (h: number) =>
      new Date(f!.h.deps.now().getTime() + h * HOUR).toISOString();
    expect(
      await code(
        m(f, "planSwitchover")(
          {},
          { environmentId: f.oldEnv, windowStart: at(10), windowEnd: at(11) },
          asAdmin,
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    const planned = await m(f, "planSwitchover")(
      {},
      { environmentId: f.oldEnv, windowStart: at(80), windowEnd: at(82) },
      asAdmin,
    );
    expect(planned).toMatchObject({
      mode: "real",
      state: "PLANNED",
      environmentId: f.oldEnv,
      canRollBack: true,
      rollBackLosesWrites: false,
    });
    const dry = await m(f, "dryRunSwitchover")(
      {},
      { environmentId: f.oldEnv },
      asAdmin,
    );
    expect(dry).toMatchObject({ mode: "dry_run", state: "PLANNED" });
    expect(
      await m(f, "freezeAppReleases")(
        {},
        { appId: f.appId, reason: "switch-over" },
        asAdmin,
      ),
    ).toBe(true);
    expect(
      await f.h.deps
        .licensingDb!.selectFrom("app_release_settings")
        .select("frozen_reason")
        .where("app_id", "=", f.appId)
        .executeTakeFirst(),
    ).toEqual({ frozen_reason: "switch-over" });
    expect(
      await m(f, "unfreezeAppReleases")({}, { appId: f.appId }, asAdmin),
    ).toBe(true);
    expect(
      await code(
        m(f, "freezeAppReleases")(
          {},
          { appId: f.appId, reason: "  " },
          asAdmin,
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(m(f, "resumeSwitchover")({}, { id: planned.id }, asAdmin)),
    ).toBe("BAD_USER_INPUT");
    const rolled = await m(f, "rollBackSwitchover")(
      {},
      { id: planned.id, acceptDataLoss: null },
      asAdmin,
    );
    expect(rolled).toMatchObject({ state: "ROLLING_BACK" });
    const audit = (await listAudit(f.h.db, f.appId, { limit: 50 })).map(
      (a) => a.action,
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        "switchover.planned",
        "releases.frozen",
        "releases.unfrozen",
        "switchover.rolled_back",
      ]),
    );
  });

  it("adoptLicensedKind goes through the API (admin) to a plan of the kind", async () => {
    f = await flow({ frozen: false });
    await f.h.db.deleteFrom("plans").execute();
    const plan = await m(f, "adoptLicensedKind")(
      {},
      {
        appId: f.appId,
        kind: "sektar-cloud",
        slug: "cloud",
        name: "Cloud",
        size: "VETRA_AGENT_M",
        targetVersion: "1.4.0",
      },
      asAdmin,
    );
    expect(plan).toMatchObject({
      kind: "sektar-cloud",
      access: "own",
      targetVersion: "1.4.0",
    });
  });
});

describe("confirmSwitchover through the API", () => {
  it("is the holder's; an admin or a stranger gets not found; the holder never sees counts", async () => {
    f = await flow();
    await drive(f, "AWAITING_CONFIRMATION");
    for (const who of [asAdmin, asOwner, asStranger])
      expect(
        await code(m(f, "confirmSwitchover")({}, { id: f.sw.id }, who)),
      ).toBe("NOT_FOUND");
    const row = await m(f, "confirmSwitchover")({}, { id: f.sw.id }, asHolder);
    expect(row).toMatchObject({
      id: f.sw.id,
      state: "AWAITING_CONFIRMATION",
      sourceCounts: null,
      copyCounts: null,
      startedCounts: null,
      timings: null,
      error: null,
      canRollBack: false,
      rollBackLosesWrites: false,
    });
    expect(row.confirmedAt).not.toBeNull();
  });
});
