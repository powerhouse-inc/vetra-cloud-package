import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import {
  listInstances,
  updateInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listAudit } from "../audit/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});

const audit = () => listAudit(h.db, appId, { limit: 200 });
const detail = (d: string) =>
  JSON.parse(d) as {
    kind: string;
    name: string;
    from: string;
    to: string;
    reason: string | null;
  };

/** A branch instance that went pending → updating → ready. */
async function readyInstance(): Promise<InstanceRow> {
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
  await reconcileInstancesOnce(h.deps);
  const row = (await listInstances(h.db, appId))[0];
  h.envs.setStatus(row.environment_id!, "READY");
  await reconcileInstancesOnce(h.deps);
  const ready = (await listInstances(h.db, appId))[0];
  expect(ready.status).toBe("ready");
  return ready;
}

/** Counts the writes and row locks of the instances table issued through it. */
function instanceWrites(): KyselyPlugin & { updates: number; locks: number } {
  const counter = {
    updates: 0,
    locks: 0,
    transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
      const json = JSON.stringify(node);
      if (json.includes('"name":"instances"')) {
        if (node.kind === "UpdateQueryNode") counter.updates++;
        if (node.kind === "SelectQueryNode" && json.includes('"ForUpdate"'))
          counter.locks++;
      }
      return node;
    },
    async transformResult({
      result,
    }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return result;
    },
  };
  return counter;
}

describe("instance status changes in the audit log", () => {
  it("records each change as Vetra (system), and nothing while the instance stays ready", async () => {
    const row = await readyInstance();
    const rows = await audit();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(r).toMatchObject({
        actor: "vetra",
        source: "system",
        action: "instance.status",
        subject: `instance:${row.id}`,
      });
    const changes = rows.map((r) => detail(r.detail)).reverse();
    for (const c of changes) expect(c.from).not.toBe(c.to);
    expect(changes.at(-1)).toMatchObject({
      kind: "branch",
      name: "main",
      from: "updating",
      to: "ready",
    });

    for (let i = 0; i < 3; i++) await reconcileInstancesOnce(h.deps);
    expect(await audit()).toHaveLength(rows.length);
  });

  it("a steady reconciler pass writes and locks no instance row", async () => {
    await readyInstance();
    const counter = instanceWrites();
    h.deps.db = h.db.withPlugin(counter);
    for (let i = 0; i < 3; i++) await reconcileInstancesOnce(h.deps);
    expect({ updates: counter.updates, locks: counter.locks }).toEqual({
      updates: 0,
      locks: 0,
    });
  });

  it("writes a row only when a write changes the status, also inside a caller's transaction", async () => {
    const row = await readyInstance();
    const n = (await audit()).length;
    const now = () => h.deps.now().toISOString();
    await updateInstance(h.db, row.id, { reason: "a note" }, now());
    await updateInstance(h.db, row.id, { status: "ready" }, now());
    expect(await audit()).toHaveLength(n);
    await updateInstance(
      h.db,
      row.id,
      { status: "failed", reason: "boom" },
      now(),
    );
    expect(detail((await audit())[0].detail)).toMatchObject({
      from: "ready",
      to: "failed",
      reason: "boom",
    });
    await h.db
      .transaction()
      .execute((trx) =>
        updateInstance(trx, row.id, { status: "pending" }, now()),
      );
    expect(detail((await audit())[0].detail)).toMatchObject({
      from: "failed",
      to: "pending",
    });
    expect(await audit()).toHaveLength(n + 2);
  });

  it("a write without a status is one UPDATE and no lock", async () => {
    const row = await readyInstance();
    const counter = instanceWrites();
    const db = h.db.withPlugin(counter);
    await updateInstance(
      db,
      row.id,
      { reason: "a note" },
      h.deps.now().toISOString(),
    );
    expect({ updates: counter.updates, locks: counter.locks }).toEqual({
      updates: 1,
      locks: 0,
    });
    await updateInstance(
      db,
      row.id,
      { status: "failed" },
      h.deps.now().toISOString(),
    );
    expect(counter.locks).toBe(1);
  });
});
