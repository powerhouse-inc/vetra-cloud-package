import { describe, it, expect, vi } from "vitest";
import { GraphQLError, buildASTSchema, type GraphQLObjectType } from "graphql";
import { schema } from "../schema.js";
import type { Kysely } from "kysely";
import { toPublisherGraphQLError, OperationRejectedError } from "../publisher-errors.js";
import { UnauthenticatedError, AppIdentityInactiveError } from "../auth.js";
import { NotAppOwnerError, UnknownAppError } from "../publisher-auth.js";
import {
  UnknownLicenseTypeError,
  UnknownLicenseError,
  createPublisherResolvers,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { LicensingDisabledError } from "../resolvers.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
} from "../template.js";
import {
  InvalidHolderAddressError,
  LicenseTypeNotIssuableError,
  NotOnAllowListError,
} from "../issuers/publisher-grant.js";
import { NegativeValidityError } from "../../../document-models/app-license-type/v1/gen/license-type/error.js";
import { createReactorLicenseTypeGateway } from "../license-type-gateway.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import type { VetraLicensingDB } from "../db/schema.js";

const codeOf = (e: unknown) => (e as GraphQLError).extensions?.code;

describe("toPublisherGraphQLError", () => {
  it("maps each licensing error to its code and keeps the message verbatim", () => {
    const cases: Array<[Error, string]> = [
      [new UnauthenticatedError("sign in to manage licences"), "UNAUTHENTICATED"],
      [new UnknownAppError("no such app"), "UNKNOWN_APP"],
      [new AppIdentityInactiveError("app identity inactive"), "APP_IDENTITY_INACTIVE"],
      [new LicensingDisabledError("licensing is disabled"), "LICENSING_DISABLED"],
      [new UnknownLicenseTypeError(), "UNKNOWN_LICENSE_TYPE"],
      [new UnknownLicenseError(), "UNKNOWN_LICENSE"],
    ];
    for (const [err, code] of cases) {
      const out = toPublisherGraphQLError(err);
      expect(out).toBeInstanceOf(GraphQLError);
      expect(codeOf(out)).toBe(code);
      expect((out as GraphQLError).message).toBe(err.message);
    }
  });

  it.each([
    ["UnknownTemplateSizeError", new UnknownTemplateSizeError("x")],
    ["UnsupportedTemplateServiceError", new UnsupportedTemplateServiceError("x")],
    ["MissingPackageNameError", new MissingPackageNameError("x")],
    ["NegativeValidityError", new NegativeValidityError("validityDays must be positive")],
    ["InvalidHolderAddressError", new InvalidHolderAddressError("bad address")],
    ["LicenseTypeNotIssuableError", new LicenseTypeNotIssuableError("not issuable")],
    ["OperationRejectedError", new OperationRejectedError("PUBLISH_LICENSE_TYPE rejected: x")],
  ] as Array<[string, Error]>)("maps %s to INVALID_INPUT, message verbatim", (_n, err) => {
    const out = toPublisherGraphQLError(err);
    expect(out).toBeInstanceOf(GraphQLError);
    expect(codeOf(out)).toBe("INVALID_INPUT");
    expect((out as GraphQLError).message).toBe(err.message);
  });

  it("maps NotOnAllowListError to NOT_ON_ALLOW_LIST, message verbatim", () => {
    // Unreachable in production today (isOnAllowList always returns true); pinned
    // so a real allow list does not surface as INTERNAL_SERVER_ERROR.
    const err = new NotOnAllowListError("0xabc is not on the allow list");
    const out = toPublisherGraphQLError(err) as GraphQLError;
    expect(codeOf(out)).toBe("NOT_ON_ALLOW_LIST");
    expect(out.message).toBe(err.message);
  });

  it("gives NotAppOwnerError the SAME code and message as UnknownAppError", () => {
    // The two are deliberately indistinguishable: a publisher must not be able to
    // tell another publisher's app from one that does not exist. Distinct codes
    // would reintroduce exactly the oracle the identical message text removes.
    const mine = toPublisherGraphQLError(new NotAppOwnerError("no such app")) as GraphQLError;
    const missing = toPublisherGraphQLError(new UnknownAppError("no such app")) as GraphQLError;
    expect(codeOf(mine)).toBe(codeOf(missing));
    expect(mine.message).toBe(missing.message);
  });

  it("passes an unknown error through unchanged", () => {
    const boom = new Error("something else");
    expect(toPublisherGraphQLError(boom)).toBe(boom);
  });
});

/** Anything touched beyond the auth gate fails loudly as a plain Error. */
const throwing = <T>() =>
  new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`touched: ${String(prop)}`);
      },
    },
  ) as unknown as T;

describe("publisher resolvers carry codes end to end", () => {
  const build = (over: { enabled?: boolean; owner?: string } = {}) => {
    const deps = {
      auth: {
        findAppById: vi.fn(async (id: string) =>
          id === "app-1"
            ? { id, name: "KV", status: "ACTIVE", owner_address: over.owner ?? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
            : null,
        ),
        listAppsForOwner: vi.fn(async () => []),
      },
      cfg: { enabled: over.enabled ?? true },
    } as unknown as PublisherDeps;
    return createPublisherResolvers(throwing<Kysely<VetraLicensingDB>>(), deps);
  };
  type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
  const fieldsOf = (r: Record<string, unknown>) => ({
    ...(r.VetraPublisherQueries as Record<string, Field>),
    ...(r.VetraPublisherMutations as Record<string, Field>),
  });

  it("resolver maps and the built schema define exactly the same publisher fields", () => {
    // Both directions: a resolver with no schema field is dead code, and a
    // schema field with no resolver would be a null at runtime. The count
    // follows from the schema, not from a magic number.
    const built = buildASTSchema(schema);
    const r = build();
    for (const group of ["VetraPublisherQueries", "VetraPublisherMutations"]) {
      const type = built.getType(group) as GraphQLObjectType | undefined;
      expect(type, group).toBeDefined();
      expect(Object.keys(type!.getFields()).sort(), group).toEqual(
        Object.keys(r[group] as object).sort(),
      );
    }
    expect(Object.keys(fieldsOf(r)).length).toBeGreaterThan(0);
  });

  const names = Object.keys(fieldsOf(build()));
  it.each(names)("%s maps an unauthenticated call to UNAUTHENTICATED", async (name) => {
    // A field added later without withCodes would return INTERNAL_SERVER_ERROR
    // to the browser and silently break the dashboard's error handling.
    const field = fieldsOf(build())[name];
    const err = await field(
      {},
      { appId: "a", licenseTypeId: "t", input: { appId: "a", licenseTypeId: "t", licenseId: "l" } },
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect(codeOf(err)).toBe("UNAUTHENTICATED");
  });

  it("a stranger's app and a missing app are indistinguishable by code and message", async () => {
    const stranger = { user: { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } };
    const q = fieldsOf(build()).licenseTypes;
    const notMine = (await q({}, { appId: "app-1" }, stranger).catch((e: unknown) => e)) as GraphQLError;
    const missing = (await q({}, { appId: "nope" }, stranger).catch((e: unknown) => e)) as GraphQLError;
    expect(codeOf(notMine)).toBe("UNKNOWN_APP");
    expect(codeOf(missing)).toBe("UNKNOWN_APP");
    expect(notMine.message).toBe(missing.message);
  });

  it("licensing disabled surfaces as LICENSING_DISABLED, after authorisation", async () => {
    const owner = { user: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
    const m = fieldsOf(build({ enabled: false })).createLicenseType;
    const err = await m({}, { input: { appId: "app-1", kind: "PRO" } }, owner).catch((e: unknown) => e);
    expect(codeOf(err)).toBe("LICENSING_DISABLED");
  });
});

describe("a reducer rejection reaches the browser as INVALID_INPUT", () => {
  const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  // Minimal reactor whose reducer rejects every action it is given.
  const rejectingClient = (error: string | undefined, dropOp = false) => {
    const ops: Array<{ index: number; action: { id: string; type: string }; error?: string }> = [];
    let revision = 1;
    return {
      createEmpty: async () => ({ header: {} }),
      get: async () => ({ header: { revision: { global: revision } } }),
      execute: async (_id: string, _b: string, acts: Array<{ id: string; type: string }>) => {
        if (!dropOp) for (const a of acts) ops.push({ index: revision++, action: { id: a.id, type: a.type }, error });
        return {};
      },
      getOperations: async () => ({ results: ops }),
    };
  };

  it("publishLicenseType on an incomplete template: INVALID_INPUT, text unchanged", async () => {
    const typeGateway = createReactorLicenseTypeGateway(
      rejectingClient("template is incomplete") as never,
    );
    const deps = {
      auth: {
        findAppById: async (id: string) => ({ id, name: "KV", status: "ACTIVE", owner_address: OWNER }),
        listAppsForOwner: async () => [],
      },
      reads: { licenseType: async (id: string) => ({ id, app: "app-1", status: "DRAFT" }) },
      cfg: { enabled: true },
      typeGateway,
    } as unknown as PublisherDeps;
    const m = createPublisherResolvers(throwing<Kysely<VetraLicensingDB>>(), deps)
      .VetraPublisherMutations as Record<string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>>;
    const err = (await m
      .publishLicenseType({}, { licenseTypeId: "lt-1" }, { user: { address: OWNER } })
      .catch((e: unknown) => e)) as GraphQLError;
    expect(err).toBeInstanceOf(GraphQLError);
    expect(codeOf(err)).toBe("INVALID_INPUT");
    expect(err.message).toBe("PUBLISH_LICENSE_TYPE rejected: template is incomplete");
  });

  it("both gateways throw OperationRejectedError for rejected and unapplied actions", async () => {
    const lt = createReactorLicenseTypeGateway(rejectingClient("nope") as never);
    const lic = createReactorLicenseGateway(rejectingClient("nope") as never);
    const ltDrop = createReactorLicenseTypeGateway(rejectingClient(undefined, true) as never);
    const licDrop = createReactorLicenseGateway(rejectingClient(undefined, true) as never);
    const type = (await import("document-models/app-license-type")).actions.publishLicenseType({});
    await expect(lt.execute("x", [type])).rejects.toBeInstanceOf(OperationRejectedError);
    await expect(ltDrop.execute("x", [type])).rejects.toBeInstanceOf(OperationRejectedError);
    await expect(lic.activate("x")).rejects.toBeInstanceOf(OperationRejectedError);
    await expect(licDrop.activate("x")).rejects.toBeInstanceOf(OperationRejectedError);
  });

  it("revokeLicense on an already-revoked licence: INVALID_INPUT, text unchanged", async () => {
    // The licence gateway has its own rejection detection, separate from the
    // licence-type gateway's, so it is pinned separately.
    const licenseGateway = createReactorLicenseGateway(
      rejectingClient("cannot revoke a license with status REVOKED") as never,
    );
    const deps = {
      auth: {
        findAppById: async (id: string) => ({ id, name: "KV", status: "ACTIVE", owner_address: OWNER }),
        listAppsForOwner: async () => [],
      },
      reads: { license: async (id: string) => ({ id, app: "app-1", status: "REVOKED" }) },
      cfg: { enabled: true },
      licenseGateway,
    } as unknown as PublisherDeps;
    const m = createPublisherResolvers(throwing<Kysely<VetraLicensingDB>>(), deps)
      .VetraPublisherMutations as Record<string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>>;
    const err = (await m
      .revokeLicense({}, { input: { licenseId: "lic-1" } }, { user: { address: OWNER } })
      .catch((e: unknown) => e)) as GraphQLError;
    expect(err).toBeInstanceOf(GraphQLError);
    expect(codeOf(err)).toBe("INVALID_INPUT");
    expect(err.message).toBe("REVOKE_LICENSE rejected: cannot revoke a license with status REVOKED");
  });
});
