import { describe, it, expect, vi } from "vitest";
import { GraphQLError, buildASTSchema, type GraphQLObjectType } from "graphql";
import { schema } from "../schema.js";
import {
  AppTamperedError,
  ForbiddenError,
  InvalidPublisherInputError,
  InvalidSecretNameError,
  NotOnAllowListError,
  OperationRejectedError,
  UnknownInviteCodeError,
  UnknownLicenseError,
  UnknownTemplateError,
  UnknownTenantError,
  UnknownTermError,
  toLicensingGraphQLError,
  toPublisherGraphQLError,
} from "../publisher-errors.js";
import { UnauthenticatedError, AppIdentityInactiveError, UnknownAppIdentityError } from "../auth.js";
import { NotAppOwnerError, UnknownAppError } from "../publisher-auth.js";
import { createPublisherResolvers, type PublisherDeps } from "../publisher-resolvers.js";
import { LicensingDisabledError } from "../resolvers.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
} from "../template.js";
import { AlreadyHoldsError, LicenceNotUpgradableError, TermNotIssuableError } from "../issue.js";
import { UnsupportedDidError } from "../did.js";
import { InvalidCodeError, InvalidCodeInputError } from "../invite-codes.js";
import { KeyStorageUnavailableError } from "../key-vault.js";

const codeOf = (e: unknown) => (e as GraphQLError).extensions?.code;

describe("toLicensingGraphQLError", () => {
  // One row per error class: the contract's codes (§ vetraPublisher).
  const table: Array<[string, Error, string]> = [
    ["UnauthenticatedError", new UnauthenticatedError("sign in"), "UNAUTHENTICATED"],
    ["NotAppOwnerError", new NotAppOwnerError("no such app"), "NOT_FOUND"],
    ["UnknownAppError", new UnknownAppError("no such app"), "NOT_FOUND"],
    ["UnknownLicenseError", new UnknownLicenseError(), "NOT_FOUND"],
    ["UnknownTemplateError", new UnknownTemplateError(), "NOT_FOUND"],
    ["UnknownTermError", new UnknownTermError(), "NOT_FOUND"],
    ["UnknownInviteCodeError", new UnknownInviteCodeError(), "NOT_FOUND"],
    ["UnknownTenantError", new UnknownTenantError(), "NOT_FOUND"],
    ["ForbiddenError", new ForbiddenError("no"), "FORBIDDEN"],
    ["AppTamperedError", new AppTamperedError("app-1"), "FORBIDDEN"],
    ["UnknownAppIdentityError", new UnknownAppIdentityError("not an app"), "FORBIDDEN"],
    ["AppIdentityInactiveError", new AppIdentityInactiveError("inactive"), "APP_NOT_ACTIVE"],
    ["NotOnAllowListError", new NotOnAllowListError("not listed"), "NOT_ON_ALLOW_LIST"],
    ["TermNotIssuableError", new TermNotIssuableError("not issuable"), "TERM_NOT_ISSUABLE"],
    ["UnsupportedDidError", new UnsupportedDidError("did:key"), "UNSUPPORTED_DID"],
    ["LicensingDisabledError", new LicensingDisabledError("off"), "LICENSING_DISABLED"],
    ["InvalidCodeError", new InvalidCodeError(), "INVALID_CODE"],
    ["AlreadyHoldsError", new AlreadyHoldsError("holds"), "ALREADY_HOLDS"],
    ["OperationRejectedError", new OperationRejectedError("ADD_TERM rejected: x"), "INVALID_INPUT"],
    ["InvalidPublisherInputError", new InvalidPublisherInputError("bad"), "INVALID_INPUT"],
    ["InvalidCodeInputError", new InvalidCodeInputError("bad code"), "INVALID_INPUT"],
    ["InvalidSecretNameError", new InvalidSecretNameError("X"), "INVALID_INPUT"],
    ["LicenceNotUpgradableError", new LicenceNotUpgradableError("REPLACED"), "INVALID_INPUT"],
    ["KeyStorageUnavailableError", new KeyStorageUnavailableError(), "INVALID_INPUT"],
    ["UnknownTemplateSizeError", new UnknownTemplateSizeError("x"), "INVALID_INPUT"],
    ["UnsupportedTemplateServiceError", new UnsupportedTemplateServiceError("x"), "INVALID_INPUT"],
    ["MissingPackageNameError", new MissingPackageNameError("x"), "INVALID_INPUT"],
  ];

  it.each(table)("maps %s to its code, message verbatim", (_n, err, code) => {
    const out = toLicensingGraphQLError(err);
    expect(out).toBeInstanceOf(GraphQLError);
    expect(codeOf(out)).toBe(code);
    expect((out as GraphQLError).message).toBe(err.message);
    expect((out as GraphQLError).originalError).toBe(err);
  });

  it("toPublisherGraphQLError is the same mapping", () => {
    expect(toPublisherGraphQLError).toBe(toLicensingGraphQLError);
  });

  it("missing and not-yours ids share code AND message", () => {
    // A publisher must not be able to tell another publisher's app, licence,
    // template, term or code from one that does not exist.
    const mine = toLicensingGraphQLError(new NotAppOwnerError("no such app")) as GraphQLError;
    const missing = toLicensingGraphQLError(new UnknownAppError("no such app")) as GraphQLError;
    expect(codeOf(mine)).toBe(codeOf(missing));
    expect(mine.message).toBe(missing.message);
    expect(new UnknownTemplateError().message).toBe("no such template");
    expect(new UnknownTermError().message).toBe("no such term");
    expect(new UnknownInviteCodeError().message).toBe("no such invite code");
    expect(new UnknownLicenseError().message).toBe("no such licence");
  });

  it("passes an unknown error through unchanged", () => {
    const boom = new Error("something else");
    expect(toLicensingGraphQLError(boom)).toBe(boom);
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

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("publisher resolvers carry codes end to end", () => {
  const build = (over: { enabled?: boolean } = {}) => {
    // Only the auth lookup, the grant row of "lic-1" and the switch are real:
    // every other dependency throws if touched.
    const real = {
      auth: {
        findAppById: vi.fn(async (id: string) =>
          id === "app-1" ? { id, name: "KV", status: "ACTIVE", owner_address: OWNER } : null,
        ),
        listAppsForOwner: vi.fn(async () => []),
      },
      grants: { grantFor: async (id: string) => (id === "lic-1" ? { licenseId: id, appId: "app-1", userDid: "x", kind: "k" } : null) },
      cfg: { enabled: over.enabled ?? true },
    };
    return createPublisherResolvers(
      new Proxy({}, { get: (_t, p: string) => (real as Record<string, unknown>)[p] ?? throwing() }) as unknown as PublisherDeps,
    );
  };
  type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
  const fieldsOf = (r: Record<string, unknown>) => ({
    ...(r.VetraPublisherQueries as Record<string, Field>),
    ...(r.VetraPublisherMutations as Record<string, Field>),
  });
  /** One argument object that satisfies every field's shape. */
  const args = (appId: string, licenseId: string) => ({
    appId,
    templateId: "t",
    termId: "k",
    code: "c",
    user: "0x1111111111111111111111111111111111111111",
    active: true,
    input: { appId, templateId: "t", termId: "k", licenseId, kind: "k", mode: "SHARED", type: "CONNECT", id: "x", packageName: "p", user: "0x1111111111111111111111111111111111111111" },
  });

  it("resolver maps and the built schema define exactly the same publisher fields", () => {
    const built = buildASTSchema(schema);
    const r = build();
    for (const group of ["VetraPublisherQueries", "VetraPublisherMutations"]) {
      const type = built.getType(group) as GraphQLObjectType | undefined;
      expect(type, group).toBeDefined();
      expect(Object.keys(type!.getFields()).sort(), group).toEqual(Object.keys(r[group] as object).sort());
    }
  });

  const names = Object.keys(fieldsOf(build()));
  it.each(names)("%s maps an unauthenticated call to UNAUTHENTICATED", async (name) => {
    // A field added later without withCodes would return INTERNAL_SERVER_ERROR.
    const err = await fieldsOf(build())[name]!({}, args("app-1", "lic-1"), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect(codeOf(err)).toBe("UNAUTHENTICATED");
  });

  const keyed = names.filter((n) => n !== "myApps");
  it.each(keyed)("%s: a stranger's id and a missing id are indistinguishable, even when disabled", async (name) => {
    for (const enabled of [true, false]) {
      const f = fieldsOf(build({ enabled }))[name]!;
      const notMine = (await f({}, args("app-1", "lic-1"), { user: { address: STRANGER } }).catch((e: unknown) => e)) as GraphQLError;
      const missing = (await f({}, args("nope", "nope"), { user: { address: STRANGER } }).catch((e: unknown) => e)) as GraphQLError;
      expect(codeOf(notMine)).toBe("NOT_FOUND");
      expect(codeOf(missing)).toBe("NOT_FOUND");
      expect(notMine.message).toBe(missing.message);
    }
  });

  const writes = Object.keys(build().VetraPublisherMutations as object);
  it.each(writes)("%s: licensing disabled is LICENSING_DISABLED, after authorisation, before anything is touched", async (name) => {
    const f = fieldsOf(build({ enabled: false }))[name]!;
    const err = await f({}, args("app-1", "lic-1"), { user: { address: OWNER } }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe("LICENSING_DISABLED");
  });
});
