import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import {
  appSettingsFor,
  deleteAppSetting,
  setAppSetting,
} from "../settings/service.js";
import { listAppSettings } from "../settings/repo.js";
import { deleteApp } from "../service.js";
import { createResolvers } from "../resolvers.js";
import { APP_DID, OWNER, USER_KEY } from "./harness.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const set = (o: Partial<Parameters<typeof setAppSetting>[2]> = {}) =>
  setAppSetting(h.deps, owner, {
    appId,
    name: "FOO",
    value: "bar",
    secret: false,
    ...o,
  });

describe("publisher settings", () => {
  it("stores a plain setting and shows its value", async () => {
    expect(await set()).toMatchObject({
      name: "FOO",
      scope: "ALL",
      secret: false,
      value: "bar",
    });
    const all = await appSettingsFor(h.deps, owner, appId);
    expect(all.settings).toEqual([
      expect.objectContaining({ name: "FOO", value: "bar" }),
    ]);
    expect(all.vetra.map((v) => v.name)).toContain(
      "PH_WORKFLOWS_SECRETS_MASTER_KEY",
    );
    expect(all.reservedPrefixes).toContain("VETRA_");
  });

  it("keeps a secret write-only: encrypted at rest, never returned or logged", async () => {
    const out = await set({ name: "API_TOKEN", value: "s3cret", secret: true });
    expect(out.value).toBeNull();
    const [row] = await listAppSettings(h.db, appId);
    expect(row.value).toBeNull();
    expect(row.ciphertext).not.toContain("s3cret");
    expect(
      JSON.stringify(await appSettingsFor(h.deps, owner, appId)),
    ).not.toContain("s3cret");
    const logged = JSON.stringify([
      (h.deps.logger.info as any).mock.calls,
      (h.deps.logger.warn as any).mock.calls,
      (h.deps.logger.error as any).mock.calls,
    ]);
    expect(logged).toContain("API_TOKEN");
    expect(logged).not.toContain("s3cret");
  });

  it("replacing a secret gives it a new write id; a plain one may become secret", async () => {
    await set({ name: "K", value: "a", secret: true });
    const w1 = (await listAppSettings(h.db, appId))[0].write_id;
    await set({ name: "K", value: "a", secret: true });
    expect((await listAppSettings(h.db, appId))[0].write_id).not.toBe(w1);
    await set({ name: "P", value: "x" });
    await set({ name: "P", value: "y", secret: true });
    const p = (await listAppSettings(h.db, appId)).find((r) => r.name === "P")!;
    expect(p).toMatchObject({ secret: true, value: null });
  });

  it("scopes a setting to one kind and deletes it by scope", async () => {
    await set({ scope: "PREVIEW", value: "p" });
    await set({ value: "all" });
    expect(
      (await appSettingsFor(h.deps, owner, appId)).settings.map((s) => s.scope),
    ).toEqual(["ALL", "PREVIEW"]);
    expect(await deleteAppSetting(h.deps, owner, appId, "FOO", "PREVIEW")).toBe(
      true,
    );
    expect(await deleteAppSetting(h.deps, owner, appId, "FOO", "PREVIEW")).toBe(
      false,
    );
    expect((await appSettingsFor(h.deps, owner, appId)).settings).toHaveLength(
      1,
    );
  });

  it("refuses names Vetra sets, malformed names and bad values (BAD_USER_INPUT)", async () => {
    for (const o of [
      { name: "ADMINS" },
      { name: "VETRA_X" },
      { name: "lower" },
      { name: "S", value: "", secret: true },
      { scope: "NOPE" as never },
    ])
      await expect(set(o)).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
  });

  it("caps an App at 100 settings, replacing one is still allowed", async () => {
    for (let i = 0; i < 100; i++) await set({ name: `S${i}`, value: "v" });
    await expect(set({ name: "ONE_MORE" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(set({ name: "S0", value: "w" })).resolves.toBeTruthy();
  });

  it("refuses secrets without OpenBao, and strangers entirely", async () => {
    h.deps.settingsVault = null;
    await expect(set({ secret: true })).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
    await expect(
      setAppSetting(h.deps, stranger, {
        appId,
        name: "FOO",
        value: "x",
        secret: false,
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(appSettingsFor(h.deps, stranger, appId)).rejects.toMatchObject(
      {
        extensions: { code: "FORBIDDEN" },
      },
    );
    await expect(
      deleteAppSetting(h.deps, stranger, appId, "FOO"),
    ).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("reports an OpenBao outage as SERVICE_UNAVAILABLE without its detail", async () => {
    h.deps.settingsVault = {
      ...h.deps.settingsVault!,
      encrypt: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:8200");
      },
    };
    const err = await set({ secret: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: "Secret storage unavailable",
      extensions: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await listAppSettings(h.db, appId)).toEqual([]);
  });

  it("goes with the App", async () => {
    await set();
    await deleteApp(h.deps, owner, appId, false);
    expect(await listAppSettings(h.db, appId)).toEqual([]);
  });
});

describe("settings over GraphQL", () => {
  const ctx = (appKey: string, headers: Record<string, string> = {}) => ({
    user: { address: OWNER, chainId: 1, networkId: "eip155", appKey },
    headers,
  });

  it("sets, lists and deletes for the owner; an App's CI token is refused", async () => {
    const r = createResolvers(h.deps);
    const input = {
      appId,
      name: "TOKEN",
      value: "s3cret",
      secret: true,
      scope: "BRANCH" as const,
    };
    expect(
      await r.Mutation.setAppSetting(null, { input }, ctx(USER_KEY)),
    ).toMatchObject({
      name: "TOKEN",
      scope: "BRANCH",
      value: null,
    });
    const listed = await r.Query.appSettings(null, { appId }, ctx(USER_KEY));
    expect(listed.settings).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const ci = ctx(APP_DID, {
      authorization: `Bearer ${b64({ alg: "ES256" })}.${b64({
        iss: APP_DID,
        vetra: { ref: "refs/heads/main" },
      })}.sig`,
    });
    await expect(
      r.Query.appSettings(null, { appId }, ci),
    ).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(
      await r.Mutation.deleteAppSetting(
        null,
        { appId, name: "TOKEN", scope: "BRANCH" },
        ctx(USER_KEY),
      ),
    ).toBe(true);
  });
});
