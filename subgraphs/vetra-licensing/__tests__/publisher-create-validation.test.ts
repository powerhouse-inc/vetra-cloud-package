import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import {
  reducer,
  utils,
  actions,
} from "document-models/app-license-type";
import { createPublisherResolvers } from "../publisher-resolvers.js";
import type { PublisherDeps } from "../publisher-resolvers.js";
import type { VetraLicensingDB } from "../db/schema.js";

/**
 * createLicenseType must refuse BEFORE it creates a document: a rejection after
 * create() leaves an orphan (app: null) that no read can see, one per retry.
 *
 * The resolver's refusal rule is a copy of the reducer's, so this test runs the
 * REAL reducer on each boundary value and requires the resolver to refuse
 * exactly what the reducer rejects. If the reducer's rule changes, one side
 * of this table fails.
 *
 * What SET_LICENSE_TYPE_DETAILS can reject: only NegativeValidityError
 * (validityDays != null && <= 0). kind, label and app are guarded by truthiness
 * and are ignored, never rejected. The action creator additionally throws on a
 * wrongly-typed field (zod), which the resolver reaches by building the action
 * before create(). create() itself is createEmpty with no INITIALIZE/SET_OWNER:
 * this document model has neither.
 */

const APP = "app-1";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function harness() {
  const created: string[] = [];
  const typeGateway = {
    create: vi.fn(async () => {
      created.push(`NEW-${created.length + 1}`);
      return created[created.length - 1];
    }),
    execute: vi.fn(async (_id: string, _a: Action[]) => undefined),
  };
  const deps = {
    auth: {
      findAppById: vi.fn(async (id: string) => ({
        id,
        name: id,
        status: "ACTIVE",
        owner_address: OWNER,
      })),
      listAppsForOwner: vi.fn(),
    },
    reads: {},
    cfg: { enabled: true },
    typeGateway,
  } as unknown as PublisherDeps;
  const m = createPublisherResolvers({} as Kysely<VetraLicensingDB>, deps)
    .VetraPublisherMutations as Record<
    string,
    (p: unknown, a: unknown, c: unknown) => Promise<unknown>
  >;
  const ctx = { user: { address: OWNER } };
  return { m, ctx, created, typeGateway };
}

/** Does the real reducer reject this input? */
function reducerRejects(input: {
  kind?: string | null;
  label?: string | null;
  validityDays: number | null;
}): boolean {
  const doc = reducer(
    utils.createDocument(),
    actions.setLicenseTypeDetails({ app: APP, ...input }) as never,
  );
  return doc.operations.global.some((o) => o.error);
}

const CASES: Array<[string, number | null]> = [
  ["zero", 0],
  ["negative", -1],
  ["large negative", -365],
  ["null (no expiry)", null],
  ["one", 1],
  ["positive", 30],
];

describe("createLicenseType validates before creating", () => {
  it.each(CASES)(
    "%s: the resolver refuses exactly when the real reducer rejects",
    async (_name, validityDays) => {
      const h = harness();
      const rejected = reducerRejects({ kind: "PRO", validityDays });

      const call = h.m.createLicenseType(
        {},
        { input: { appId: APP, kind: "PRO", validityDays } },
        h.ctx,
      );

      if (rejected) {
        await expect(call).rejects.toThrow();
        expect(h.created).toEqual([]);
        expect(h.typeGateway.create).not.toHaveBeenCalled();
        expect(h.typeGateway.execute).not.toHaveBeenCalled();
      } else {
        await expect(call).resolves.toBe("NEW-1");
        expect(h.created).toHaveLength(1);
      }
    },
  );

  it("the table covers both outcomes, so neither branch can be vacuous", () => {
    const outcomes = CASES.map(([, v]) => reducerRejects({ validityDays: v }));
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it("omitted validityDays is accepted, as the reducer accepts it", async () => {
    const h = harness();
    expect(reducerRejects({ validityDays: null })).toBe(false);
    await expect(
      h.m.createLicenseType({}, { input: { appId: APP, kind: "PRO" } }, h.ctx),
    ).resolves.toBe("NEW-1");
  });

  it("a wrongly typed field is refused by the action creator before create()", async () => {
    const h = harness();
    await expect(
      h.m.createLicenseType(
        {},
        { input: { appId: APP, kind: "PRO", validityDays: "30" } },
        h.ctx,
      ),
    ).rejects.toThrow();
    expect(h.created).toEqual([]);
  });

  it("repeated rejected creates leave no document at all", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      await h.m
        .createLicenseType(
          {},
          { input: { appId: APP, kind: "PRO", validityDays: 0 } },
          h.ctx,
        )
        .catch(() => undefined);
    }
    expect(h.created).toEqual([]);
  });
});
