import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import { createGrantStore } from "../grants.js";
import { createLifecycleStore } from "../lifecycle.js";
import { UnauthenticatedError } from "../auth.js";
import { UnsupportedDidError } from "../did.js";
import { InvalidPublisherInputError } from "../publisher-errors.js";
import {
  LICENSING_URL_ENV,
  REPORTING_HEADER,
  REPORTING_TOKEN_SECRET,
  createReportingTokenIssuer,
  deleteReportingToken,
  ensureReportingTokens,
  environmentForToken,
  hashToken,
  newReportingToken,
  relayUserStat,
  type RelayDeps,
  type ReportingDeps,
} from "../reporting.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const OTHER = "0x2222222222222222222222222222222222222222";
const APP_DID = "did:key:zApp";

let db: Kysely<VetraLicensingDB>;
let rep: ReportingDeps;
let setSecrets: ReturnType<typeof vi.fn>;
let n = 0;

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  n = 0;
  setSecrets = vi.fn(async () => {});
  rep = {
    db,
    secrets: { setSecrets },
    tenantIdOf: async (id) => (id === "pending" ? null : `tenant-${id}`),
    envStatus: async (id) => (id.startsWith("asleep") ? "STOPPED" : "READY"),
    licensingUrl: "https://sb/graphql/vetra-licensing",
    newToken: () => `token-${++n}`,
    now: () => "t",
    logger: { info: vi.fn(), warn: vi.fn() },
  };
});
afterEach(async () => {
  await db.destroy();
});

describe("reporting token constants", () => {
  it("names the header, the secret and the endpoint variable", () => {
    expect(REPORTING_HEADER).toBe("x-vetra-reporting-token");
    expect(REPORTING_TOKEN_SECRET).toBe("VETRA_REPORTING_TOKEN");
    expect(LICENSING_URL_ENV).toBe("VETRA_LICENSING_URL");
    const a = newReportingToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newReportingToken()).not.toBe(a);
    expect(hashToken("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });
});

describe("ensureReportingTokens", () => {
  it("writes the token and the endpoint into the environment's secrets, storing only a hash", async () => {
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).toHaveBeenCalledWith("tenant-e1", [
      { key: "VETRA_REPORTING_TOKEN", value: "token-1" },
      { key: "VETRA_LICENSING_URL", value: "https://sb/graphql/vetra-licensing" },
    ]);
    const rows = await db.selectFrom("environment_reporting_tokens").selectAll().execute();
    expect(rows).toStrictEqual([{ environment_id: "e1", token_hash: hashToken("token-1"), created_at: "t" }]);
    expect(JSON.stringify(rows)).not.toContain("token-1");
    expect(await environmentForToken(db, "token-1")).toBe("e1");
    expect(await environmentForToken(db, "wrong")).toBeNull();
    expect(await environmentForToken(db, "")).toBeNull();
  });

  it("is idempotent and waits for a tenant id", async () => {
    await ensureReportingTokens(rep, ["e1", "pending"]);
    await ensureReportingTokens(rep, ["e1", "pending"]);
    expect(setSecrets).toHaveBeenCalledTimes(1);
    await ensureReportingTokens(rep, []);
    expect(setSecrets).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a secrets service or a licensing URL, and says so once", async () => {
    await ensureReportingTokens({ ...rep, secrets: null }, ["e1"]);
    const noUrl = { ...rep, licensingUrl: null };
    await ensureReportingTokens(noUrl, ["e1"]);
    await ensureReportingTokens(noUrl, ["e2"]);
    expect(setSecrets).not.toHaveBeenCalled();
    expect(await db.selectFrom("environment_reporting_tokens").selectAll().execute()).toStrictEqual([]);
    expect(rep.logger.info).toHaveBeenCalledTimes(2);
    expect(rep.logger.info).toHaveBeenCalledWith(expect.stringContaining("VETRA_LICENSING_URL"));
  });

  it("writes no row when the secret write fails, logs without the token, and tries again later", async () => {
    setSecrets.mockRejectedValueOnce(new Error("transit down"));
    await ensureReportingTokens(rep, ["e1", "e2"]);
    expect(await environmentForToken(db, "token-1")).toBeNull();
    expect(await environmentForToken(db, "token-2")).toBe("e2");
    expect(rep.logger.warn).toHaveBeenCalledWith(expect.stringContaining("e1"));
    for (const [msg] of (rep.logger.warn as ReturnType<typeof vi.fn>).mock.calls as [string][]) {
      expect(msg).not.toMatch(/token-\d/);
    }
    await ensureReportingTokens(rep, ["e1", "e2"]);
    expect(await environmentForToken(db, "token-3")).toBe("e1");
  });

  it("never issues twice for an environment whose issue is still running", async () => {
    let release: () => void = () => {};
    setSecrets.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const first = ensureReportingTokens(rep, ["e1"]);
    await vi.waitFor(() => expect(setSecrets).toHaveBeenCalledTimes(1));
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(await environmentForToken(db, "token-1")).toBe("e1");
  });

  it("an environment with a token row is never re-issued", async () => {
    await db.insertInto("environment_reporting_tokens").values({ environment_id: "e1", token_hash: "old", created_at: "t0" }).execute();
    // An existing row means a token was issued: nothing is written.
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).not.toHaveBeenCalled();
  });

  it("deleteReportingToken forgets an environment's token", async () => {
    await ensureReportingTokens(rep, ["e1", "e2"]);
    await deleteReportingToken(db, "e1");
    expect(await environmentForToken(db, "token-1")).toBeNull();
    expect(await environmentForToken(db, "token-2")).toBe("e2");
  });
});

describe("reporting token issue without restart loops (fix round 1)", () => {
  it("a failing hash write never writes the secret again: the minted token is reused", async () => {
    const insert = vi.spyOn(db, "insertInto");
    insert.mockImplementationOnce(() => { throw new Error("db down"); });
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(await environmentForToken(db, "token-1")).toBeNull();
    insert.mockRestore();
    await ensureReportingTokens(rep, ["e1"]);
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(await environmentForToken(db, "token-1")).toBe("e1");
    expect(n).toBe(1);
  });
});

describe("reporting token budget per tick (fix round 1)", () => {
  const issued = () => setSecrets.mock.calls.map(([tenant]) => String(tenant).replace("tenant-", ""));

  it("is one global budget per tick across apps; asleep environments are free and go first", async () => {
    const issuer = createReportingTokenIssuer(rep, 2);
    issuer.startTick();
    await issuer.issue(["a1", "a2", "asleep-1"]); // app 1
    await issuer.issue(["b1", "asleep-2", "b2"]); // app 2
    issuer.endTick();
    expect(issued()).toStrictEqual(["asleep-1", "a1", "a2", "asleep-2"]);
    expect(rep.logger.info).toHaveBeenCalledWith(expect.stringContaining("2 reporting token(s) pending"));

    // Pending environments are picked up on the next tick.
    issuer.startTick();
    await issuer.issue(["a1", "a2", "asleep-1"]);
    await issuer.issue(["b1", "asleep-2", "b2"]);
    issuer.endTick();
    expect(issued()).toStrictEqual(["asleep-1", "a1", "a2", "asleep-2", "b1", "b2"]);
    expect(rep.logger.info).toHaveBeenCalledWith(expect.stringContaining("all reporting tokens issued"));

    // Nothing left: a quiet tick logs nothing new.
    const logged = (rep.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
    issuer.startTick();
    await issuer.issue(["a1", "a2", "asleep-1"]);
    issuer.endTick();
    expect((rep.logger.info as ReturnType<typeof vi.fn>).mock.calls.length).toBe(logged);
  });

  it("logs the pending count once per change", async () => {
    const issuer = createReportingTokenIssuer(rep, 1);
    for (let i = 0; i < 2; i++) {
      issuer.startTick();
      await issuer.issue([`x${i}`, "y", "z"]);
      issuer.endTick();
    }
    const pendingLogs = (rep.logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => String(m).includes("pending"));
    // Tick 1: x0 issued, y z pending (2). Tick 2: x1 issued, y z still pending (2): not logged again.
    expect(pendingLogs).toHaveLength(1);
  });

  it("a budget of 0 issues only to asleep environments", async () => {
    const issuer = createReportingTokenIssuer(rep, 0);
    issuer.startTick();
    await issuer.issue(["e1", "asleep-1"]);
    issuer.endTick();
    expect(issued()).toStrictEqual(["asleep-1"]);
  });

  it("an environment without a tenant yet spends no budget", async () => {
    const issuer = createReportingTokenIssuer(rep, 1);
    issuer.startTick();
    await issuer.issue(["pending", "e1"]);
    issuer.endTick();
    expect(issued()).toStrictEqual(["e1"]);
  });

  it("an environment whose status cannot be read counts as awake", async () => {
    const issuer = createReportingTokenIssuer({ ...rep, envStatus: () => Promise.reject(new Error("x")) }, 1);
    issuer.startTick();
    await issuer.issue(["asleep-1", "e1"]);
    issuer.endTick();
    expect(issued()).toStrictEqual(["asleep-1"]);
  });
});

describe("environments that will never run again", () => {
  const byName: Record<string, string> = { gone: "DESTROYED", shelved: "ARCHIVED", draft: "DRAFT", stopped: "STOPPED" };
  const withStatuses = (): ReportingDeps => ({ ...rep, envStatus: async (id) => byName[id] ?? "READY" });

  it("issues no token to a DESTROYED or ARCHIVED environment, while STOPPED and DRAFT stay free", async () => {
    const issuer = createReportingTokenIssuer(withStatuses(), 0);
    issuer.startTick();
    await issuer.issue(["gone", "shelved", "draft", "stopped", "live"]);
    issuer.endTick();
    expect(setSecrets.mock.calls.map((c) => c[0])).toStrictEqual(["tenant-draft", "tenant-stopped"]);
    expect(await db.selectFrom("environment_reporting_tokens").select("environment_id").execute()).toHaveLength(2);
  });

  it("forgets an unrecorded token when the environment is destroyed", async () => {
    const insert = vi.spyOn(db, "insertInto");
    insert.mockImplementationOnce(() => { throw new Error("db down"); });
    const issuer = createReportingTokenIssuer(rep, 5);
    issuer.startTick();
    await issuer.issue(["e1"]);
    insert.mockRestore();
    expect(setSecrets).toHaveBeenCalledTimes(1);
    issuer.forget("e1");
    issuer.startTick();
    await issuer.issue(["e1"]);
    // The stale token was not reused: a new one was minted and written.
    expect(setSecrets).toHaveBeenCalledTimes(2);
    expect(await environmentForToken(db, "token-1")).toBeNull();
    expect(await environmentForToken(db, "token-2")).toBe("e1");
  });
});

describe("a destroyed environment with a token written but not recorded", () => {
  it("never gets its hash recorded: the status check runs before the unrecorded-token branch", async () => {
    let status = "READY";
    const deps: ReportingDeps = { ...rep, envStatus: async () => status };
    const insert = vi.spyOn(db, "insertInto");
    insert.mockImplementationOnce(() => { throw new Error("db down"); });
    const issuer = createReportingTokenIssuer(deps, 5);
    issuer.startTick();
    await issuer.issue(["e1"]);
    insert.mockRestore();
    expect(setSecrets).toHaveBeenCalledTimes(1);

    status = "DESTROYED";
    issuer.startTick();
    await issuer.issue(["e1"]);
    issuer.endTick();
    // Neither a second secret write nor a recorded hash for the gone environment.
    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("environment_reporting_tokens").selectAll().execute()).toStrictEqual([]);
    expect(await environmentForToken(db, "token-1")).toBeNull();
  });
});

describe("relayUserStat", () => {
  let relay: RelayDeps;
  let enqueue: ReturnType<typeof vi.fn>;
  let appDoc: { id: string; tampered: boolean; identityDid: string | null } | null;
  let appRow: { identityDid: string | null; status: string } | null;
  const grants = () => createGrantStore(db);
  const lifecycle = () => createLifecycleStore(db, () => "t");
  const setStatus = (id: string, type: string) =>
    lifecycle().record(id, [{ type, input: {} } as never]);

  beforeEach(async () => {
    const envRows = createChainEnvironmentRows(db, loadLicensingConfig({}));
    await envRows.claim({
      environment_id: "e1", root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1",
      template_id: null, label: null, template_hash: "h", ended_at: null, stopped_at: null,
      delete_after: null, created_at: "t", updated_at: "t",
    });
    await grants().recordGrant({ licenseId: "l1", appId: "app-1", kind: "pro", userDid: DID, issuedBy: "0xowner", now: "t" });
    await setStatus("l1", "ACTIVATE_LICENSE");
    await ensureReportingTokens(rep, ["e1"]);
    enqueue = vi.fn(() => true);
    // The document says another identity: it must never be used.
    appDoc = { id: "app-1", tampered: false, identityDid: "did:key:zForged" };
    appRow = { identityDid: APP_DID, status: "ACTIVE" };
    relay = {
      db,
      envRows,
      grants: grants(),
      lifecycle: lifecycle(),
      apps: { app: async () => appDoc as never },
      appIdentity: async (id) => (id === "app-1" ? appRow : null),
      stats: { enqueue, flush: async () => {}, stop: () => {} },
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => "2026-10-08T00:00:00.000Z",
    };
  });

  const stat = (user = DID, metric = "notes", value = 4) => ({ user, metric, value });

  it("refuses a chain head recorded ACTIVE whose end has passed, before the keeper expires it", async () => {
    const setEnd = (end: string | null) =>
      db.updateTable("license_lifecycle").set({ end_at: end }).where("license_id", "=", "l1").execute();
    await setEnd("2026-10-01T00:00:00.000Z");
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(relay.logger.info).toHaveBeenCalledWith(expect.stringContaining("its chain head l1 ended 2026-10-01T00:00:00.000Z"));
    await setEnd("2026-11-01T00:00:00.000Z");
    expect(await relayUserStat(relay, "token-1", stat())).toBe(true);
  });

  it("forwards the holder's stat as the app's recorded identity for a live chain", async () => {
    expect(await relayUserStat(relay, "token-1", stat(ADDR))).toBe(true);
    expect(enqueue).toHaveBeenCalledWith({ appDid: APP_DID, userDid: DID, metric: "notes", value: 4 });
    expect(await relayUserStat(relay, "token-1", stat("did:pkh:eip155:137:" + ADDR.toUpperCase().replace("0X", "0x"), "a.b:c-d_e", 0))).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith({ appDid: APP_DID, userDid: DID, metric: "a.b:c-d_e", value: 0 });
  });

  it("follows the chain to its head: a renewed chain is live while its newest licence is ACTIVE", async () => {
    await grants().recordGrant({ licenseId: "l2", appId: "app-1", kind: "pro", userDid: DID, issuedBy: "0xowner", now: "t2" });
    await grants().linkChain({ licenseId: "l2", rootLicenseId: "l1", appId: "app-1", label: null, now: "t2" });
    await setStatus("l2", "ISSUE_LICENSE");
    // The root is still recorded ACTIVE, but the head is only ISSUED.
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    await setStatus("l2", "ACTIVATE_LICENSE");
    await setStatus("l1", "REPLACE_LICENSE");
    expect(await relayUserStat(relay, "token-1", stat())).toBe(true);
  });

  it.each(["EXPIRE_LICENSE", "REVOKE_LICENSE"])("refuses a stat once the chain ended (%s)", async (type) => {
    await setStatus("l1", type);
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a chain whose head has no lifecycle record (the document is not evidence)", async () => {
    await db.deleteFrom("license_lifecycle").execute();
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
  });

  it("refuses a stat about anyone but the environment's holder", async () => {
    expect(await relayUserStat(relay, "token-1", stat(OTHER))).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the head's grant is for another app or holder", async () => {
    await db.updateTable("app_license_grants").set({ app_id: "app-2" }).execute();
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    await db.updateTable("app_license_grants").set({ app_id: "app-1", user_did: `did:pkh:eip155:1:${OTHER}`, user_address: OTHER }).execute();
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    await db.deleteFrom("app_license_grants").execute();
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a tampered or unreadable app", async () => {
    appDoc = { id: "app-1", tampered: true, identityDid: APP_DID };
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    appDoc = null;
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ identityDid: null, status: "ACTIVE" }],
    [{ identityDid: "", status: "ACTIVE" }],
    [{ identityDid: APP_DID, status: "DELETED" }],
    [{ identityDid: APP_DID, status: "PENDING_IDENTITY" }],
  ])("refuses an app without a usable recorded identity: %o", async (row) => {
    appRow = row;
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses an environment whose chain row is gone (destroyed)", async () => {
    await db.deleteFrom("license_environments").execute();
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
  });

  it("returns false when the relay is off", async () => {
    enqueue.mockReturnValue(false);
    expect(await relayUserStat(relay, "token-1", stat())).toBe(false);
  });

  it("logs a refusal once per change, never with the token", async () => {
    await relayUserStat(relay, "token-1", stat(OTHER));
    await relayUserStat(relay, "token-1", stat(OTHER));
    expect(relay.logger.info).toHaveBeenCalledTimes(1);
    await setStatus("l1", "EXPIRE_LICENSE");
    await relayUserStat(relay, "token-1", stat());
    await relayUserStat(relay, "token-1", stat());
    expect(relay.logger.info).toHaveBeenCalledTimes(2);
    await setStatus("l1", "ACTIVATE_LICENSE");
    await relayUserStat(relay, "token-1", stat());
    await relayUserStat(relay, "token-1", stat(OTHER));
    expect(relay.logger.info).toHaveBeenCalledTimes(3);
    for (const [msg] of (relay.logger.info as ReturnType<typeof vi.fn>).mock.calls as [string][]) {
      expect(msg).not.toContain("token-1");
      expect(msg).toContain("e1");
    }
  });

  it("refuses without or with an unknown token", async () => {
    await expect(relayUserStat(relay, null, stat())).rejects.toThrow(UnauthenticatedError);
    await expect(relayUserStat(relay, "", stat())).rejects.toThrow("a reporting token is required");
    await expect(relayUserStat(relay, "nope", stat())).rejects.toThrow("unknown reporting token");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a malformed metric, a non-finite value or an unsupported DID", async () => {
    for (const metric of ["has space", "", "1starts-with-digit", "x".repeat(65)]) {
      await expect(relayUserStat(relay, "token-1", stat(DID, metric))).rejects.toThrow(InvalidPublisherInputError);
    }
    expect(await relayUserStat(relay, "token-1", stat(DID, "x".repeat(64)))).toBe(true);
    await expect(relayUserStat(relay, "token-1", stat(DID, "m", Number.NaN))).rejects.toThrow(/value/);
    await expect(relayUserStat(relay, "token-1", stat(DID, "m", Number.POSITIVE_INFINITY))).rejects.toThrow(/value/);
    await expect(relayUserStat(relay, "token-1", stat("did:key:zUser"))).rejects.toThrow(UnsupportedDidError);
  });
});

describe("relay errors on the wire", () => {
  it("map to the contract's machine codes", async () => {
    const { toLicensingGraphQLError } = await import("../publisher-errors.js");
    const code = (e: Error) => (toLicensingGraphQLError(e) as { extensions: { code?: unknown } }).extensions.code;
    expect(code(new UnauthenticatedError("unknown reporting token"))).toBe("UNAUTHENTICATED");
    expect(code(new InvalidPublisherInputError("metric"))).toBe("INVALID_INPUT");
    expect(code(new UnsupportedDidError("x"))).toBe("UNSUPPORTED_DID");
  });
});
