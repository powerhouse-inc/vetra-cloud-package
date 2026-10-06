import { describe, it, expect, vi } from "vitest";
import { releaseEnvironment } from "../release.js";
import { applyEnvironmentTemplate } from "../provision.js";
import type { AppUserEnvironments } from "../db/schema.js";
import type { TemplateShape } from "../template.js";
import { FakeEnvs } from "../../vetra-apps/__tests__/harness.js";

const deps = (over: Record<string, unknown> = {}) => ({
  findRowByEnvironment: vi.fn(async () => ({
    app_id: "app-1",
    user_address: "0xaaa",
    environment_id: "env-1",
  })),
  environmentStatus: vi.fn(async () => "READY"),
  stopEnvironment: vi.fn(async () => undefined),
  deleteRow: vi.fn(async () => undefined),
  deleteEnvironment: vi.fn(async () => undefined),
  logger: { warn: vi.fn() },
  ...over,
});

describe("releaseEnvironment", () => {
  it("stops the environment and drops its row", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      true,
    );
    expect(d.stopEnvironment).toHaveBeenCalledWith("env-1");
    expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
  });

  it("is a no-op when the row is already gone", async () => {
    const d = deps({ findRowByEnvironment: vi.fn(async () => null) });
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      false,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
  });

  it("refuses an environment belonging to another app", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-2", "env-1")).resolves.toBe(
      false,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
    expect(d.deleteRow).not.toHaveBeenCalled();
  });

  // Housekeeping sleeps idle environments on its own, so a licence can easily
  // expire against an already-STOPPED environment. SLEEP_ENVIRONMENT would be
  // rejected and the row would survive forever.
  it.each(["STOPPED", "TERMINATING", "DESTROYED", "ARCHIVED"])(
    "drops the row without sleeping or deleting a %s environment",
    async (status) => {
      const d = deps({ environmentStatus: vi.fn(async () => status) });
      await expect(
        releaseEnvironment(d as never, "app-1", "env-1"),
      ).resolves.toBe(true);
      expect(d.stopEnvironment).not.toHaveBeenCalled();
      expect(d.deleteEnvironment).not.toHaveBeenCalled();
      expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
    },
  );

  it("drops the row when the environment document is gone", async () => {
    const d = deps({ environmentStatus: vi.fn(async () => null) });
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      true,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
    expect(d.deleteRow).toHaveBeenCalled();
  });

  it("reclaims a DRAFT environment document, then drops its row, without sleeping it", async () => {
    const order: string[] = [];
    const d = deps({
      environmentStatus: vi.fn(async () => "DRAFT"),
      deleteEnvironment: vi.fn(async () => {
        order.push("deleteEnvironment");
      }),
      deleteRow: vi.fn(async () => {
        order.push("deleteRow");
      }),
    });
    await expect(
      releaseEnvironment(d as never, "app-1", "env-1"),
    ).resolves.toBe(true);
    expect(d.stopEnvironment).not.toHaveBeenCalled();
    expect(d.deleteEnvironment).toHaveBeenCalledWith("env-1");
    expect(order).toEqual(["deleteEnvironment", "deleteRow"]);
  });

  // The guard is exact equality on DRAFT. Anything that ever held customer
  // state must never be hard-deleted, whatever status it is in now.
  it.each([
    "READY",
    "STOPPED",
    "DEPLOYING",
    "CHANGES_PENDING",
    "TERMINATING",
    "DESTROYED",
    "ARCHIVED",
    "draft",
    "SOMETHING_NEW",
  ])("never deletes the document of a %s environment", async (status) => {
    const d = deps({
      environmentStatus: vi.fn(async () => status),
    });
    await releaseEnvironment(d as never, "app-1", "env-1");
    expect(d.deleteEnvironment).not.toHaveBeenCalled();
  });

  it("does not delete the document when the row is missing, foreign, or the document is gone", async () => {
    const gone = deps({ environmentStatus: vi.fn(async () => null) });
    await releaseEnvironment(gone as never, "app-1", "env-1");
    expect(gone.deleteEnvironment).not.toHaveBeenCalled();

    const foreign = deps({ environmentStatus: vi.fn(async () => "DRAFT") });
    await releaseEnvironment(foreign as never, "app-2", "env-1");
    expect(foreign.deleteEnvironment).not.toHaveBeenCalled();

    const noRow = deps({
      findRowByEnvironment: vi.fn(async () => null),
      environmentStatus: vi.fn(async () => "DRAFT"),
    });
    await releaseEnvironment(noRow as never, "app-1", "env-1");
    expect(noRow.deleteEnvironment).not.toHaveBeenCalled();
  });

  it("still drops the row, and logs, when deleting the DRAFT document fails", async () => {
    const d = deps({
      environmentStatus: vi.fn(async () => "DRAFT"),
      deleteEnvironment: vi.fn(async () => {
        throw new Error("reactor down");
      }),
    });
    await expect(
      releaseEnvironment(d as never, "app-1", "env-1"),
    ).resolves.toBe(true);
    expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
    expect(d.logger.warn).toHaveBeenCalledOnce();
    expect(String(d.logger.warn.mock.calls[0][0])).toContain("env-1");
    expect(String(d.logger.warn.mock.calls[0][0])).toContain("reactor down");
  });

  // A transient status must keep failing so the next tick retries, rather than
  // dropping the row and forgetting a live environment.
  it("lets a rejection from a transient status propagate and keeps the row", async () => {
    const d = deps({
      environmentStatus: vi.fn(async () => "DEPLOYING"),
      stopEnvironment: vi.fn(async () => {
        throw new Error("SLEEP_ENVIRONMENT rejected");
      }),
    });
    await expect(
      releaseEnvironment(d as never, "app-1", "env-1"),
    ).rejects.toThrow("SLEEP_ENVIRONMENT rejected");
    expect(d.deleteRow).not.toHaveBeenCalled();
  });
});

// The leak this guards: provisioning creates the document and claims the row,
// the action list is rejected (document stays DRAFT), the licence expires
// before the retry, and the release used to forget the row but keep the
// document, leaving it unfindable forever.
describe("releaseEnvironment after a rejected provisioning", () => {
  const template: TemplateShape = {
    services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
    packages: [],
    size: null,
    baseDomain: "vetra.io",
    packageRegistry: null,
  };
  const USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("deletes the DRAFT document and the row", async () => {
    const envs = new FakeEnvs();
    const rows = new Map<string, AppUserEnvironments>();
    const key = (a: string, u: string) => `${a}|${u}`;
    const realExecute = envs.execute.bind(envs);
    envs.execute = async () => {
      throw new Error("ENABLE_SERVICE rejected");
    };

    await expect(
      applyEnvironmentTemplate(
        {
          findRow: async (a, u) => rows.get(key(a, u)) ?? null,
          countForApp: async () => rows.size,
          maxForApp: async () => 50,
          claimRow: async (r) => {
            const held = rows.get(key(r.app_id, r.user_address));
            if (held) return held;
            rows.set(key(r.app_id, r.user_address), r);
            return r;
          },
          upsertRow: async (r) => {
            rows.set(key(r.app_id, r.user_address), r);
            return r;
          },
          envs,
          generateSubdomain: (id) => `sub-${id}`,
        },
        {
          appId: "app-1",
          user: USER,
          licenseId: "lic-1",
          template,
          label: "Acme",
          now: "2026-10-06T12:00:00.000Z",
        },
      ),
    ).rejects.toThrow("ENABLE_SERVICE rejected");
    envs.execute = realExecute;

    // Precondition: a claimed row and a document stuck at DRAFT.
    const claimed = rows.get(key("app-1", USER))!;
    expect(claimed.template_hash).toBe("unapplied");
    expect((await envs.getState(claimed.environment_id))?.status).toBe("DRAFT");

    // The licence expires; the keeper's plan releases the environment.
    const stop = vi.fn(async () => undefined);
    await expect(
      releaseEnvironment(
        {
          findRowByEnvironment: async (id) =>
            [...rows.values()].find((r) => r.environment_id === id) ?? null,
          environmentStatus: async (id) =>
            (await envs.getState(id))?.status ?? null,
          stopEnvironment: stop,
          deleteRow: async (a, u) => {
            rows.delete(key(a, u));
          },
          deleteEnvironment: (id) => envs.delete(id),
          logger: { warn: vi.fn() },
        },
        "app-1",
        claimed.environment_id,
      ),
    ).resolves.toBe(true);

    expect(rows.size).toBe(0);
    expect(envs.deleted).toEqual([claimed.environment_id]);
    expect(envs.docs.has(claimed.environment_id)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("never deletes a READY document through the same wiring", async () => {
    const envs = new FakeEnvs();
    const id = await envs.seedStandalone(USER);
    const row = {
      app_id: "app-1",
      user_address: USER,
      environment_id: id,
    } as AppUserEnvironments;
    const rowsDeleted: string[] = [];
    await releaseEnvironment(
      {
        findRowByEnvironment: async () => row,
        environmentStatus: async (e) => (await envs.getState(e))?.status ?? null,
        stopEnvironment: async () => undefined,
        deleteRow: async (a) => {
          rowsDeleted.push(a);
        },
        deleteEnvironment: (e) => envs.delete(e),
        logger: { warn: vi.fn() },
      },
      "app-1",
      id,
    );
    expect(rowsDeleted).toEqual(["app-1"]);
    expect(envs.deleted).toEqual([]);
    expect(envs.docs.has(id)).toBe(true);
  });
});
