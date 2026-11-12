import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  owner,
  seedActiveApp,
  stranger,
  STRANGER,
  type Harness,
} from "./harness.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";
import {
  appSettingsFor,
  deleteAppSetting,
  setAppSetting,
} from "../settings/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});

describe("settings: release managers and the audit log", () => {
  it("audits set and delete by name, scope and secrecy, never a value", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await setAppSetting(h.deps, stranger, {
      appId,
      name: "TOKEN",
      value: "s3cret-value",
      secret: true,
    });
    await setAppSetting(h.deps, stranger, {
      appId,
      name: "TOKEN",
      value: "an0ther-value",
      secret: true,
    });
    await setAppSetting(h.deps, owner, {
      appId,
      name: "RELAY",
      value: "https://relay.example",
      secret: false,
      scope: "BRANCH",
    });
    expect(await deleteAppSetting(h.deps, stranger, appId, "TOKEN")).toBe(true);
    expect(await deleteAppSetting(h.deps, stranger, appId, "TOKEN")).toBe(
      false,
    );
    const rows = (await listAudit(h.db, appId, { limit: 50 }))
      .filter((r) => r.subject.startsWith("setting:"))
      .reverse();
    expect(rows.map((r) => [r.action, r.subject, r.actor])).toEqual([
      ["setting.set", "setting:ALL/TOKEN", STRANGER],
      ["setting.set", "setting:ALL/TOKEN", STRANGER],
      ["setting.set", "setting:BRANCH/RELAY", OWNER],
      ["setting.deleted", "setting:ALL/TOKEN", STRANGER],
    ]);
    expect(JSON.parse(rows[0].detail)).toEqual({
      name: "TOKEN",
      scope: "ALL",
      secret: true,
      replaced: false,
    });
    expect(JSON.parse(rows[1].detail)).toMatchObject({ replaced: true });
    expect(JSON.parse(rows[2].detail)).toEqual({
      name: "RELAY",
      scope: "BRANCH",
      secret: false,
      replaced: false,
    });
    expect(JSON.parse(rows[3].detail)).toEqual({ name: "TOKEN", scope: "ALL" });
    const everything = JSON.stringify(
      await h.db.selectFrom("app_audit").selectAll().execute(),
    );
    for (const s of [
      "s3cret-value",
      "an0ther-value",
      "https://relay.example",
      Buffer.from("s3cret-value").toString("base64"),
      Buffer.from("an0ther-value").toString("base64"),
    ])
      expect(everything).not.toContain(s);
  });

  it("lets a release manager read the settings; refuses an address without the role", async () => {
    await expect(appSettingsFor(h.deps, stranger, appId)).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
    await expect(
      setAppSetting(h.deps, stranger, {
        appId,
        name: "FOO",
        value: "bar",
        secret: false,
      }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    expect((await appSettingsFor(h.deps, stranger, appId)).settings).toEqual(
      [],
    );
  });
});
