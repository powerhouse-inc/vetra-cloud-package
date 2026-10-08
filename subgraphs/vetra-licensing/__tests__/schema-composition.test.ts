import { describe, expect, it } from "vitest";
import {
  buildASTSchema,
  Kind,
  type DocumentNode,
  type GraphQLObjectType,
} from "graphql";
import { machineSchema, schema } from "../schema.js";
import { publisherSchema } from "../publisher-schema.js";
import { createResolvers } from "../resolvers.js";
import { createPublisherResolvers } from "../publisher-resolvers.js";
import { mergeResolvers } from "../merge-resolvers.js";

const fieldsOf = (built: ReturnType<typeof buildASTSchema>, name: string) => {
  const t = built.getType(name) as GraphQLObjectType | undefined;
  return t ? Object.keys(t.getFields()) : [];
};

const definedNames = (doc: DocumentNode) =>
  doc.definitions.flatMap((d) =>
    "name" in d && d.name && d.kind !== Kind.OBJECT_TYPE_EXTENSION
      ? [d.name.value]
      : [],
  );

describe("subgraph schema composition", () => {
  it("builds as valid GraphQL", () => {
    expect(() => buildASTSchema(schema)).not.toThrow();
  });

  it("still serves the machine surface", () => {
    const built = buildASTSchema(schema);
    expect(fieldsOf(built, "Query")).toContain("vetraLicensing");
    expect(fieldsOf(built, "Mutation")).toContain("vetraLicensing");
    expect(fieldsOf(built, "VetraLicensingQueries")).toEqual(
      expect.arrayContaining([
        "appLicenses",
        "appLicenseTypes",
        "appUserEnvironments",
      ]),
    );
    expect(fieldsOf(built, "VetraLicensingMutations")).toEqual(
      expect.arrayContaining([
        "applyEnvironmentTemplate",
        "releaseEnvironment",
        "issuePublisherGrant",
      ]),
    );
  });

  it("also serves the publisher surface, exactly the contract's fields", () => {
    const built = buildASTSchema(schema);
    expect(fieldsOf(built, "Query")).toContain("vetraPublisher");
    expect(fieldsOf(built, "Mutation")).toContain("vetraPublisher");
    expect(fieldsOf(built, "VetraPublisherQueries")).toStrictEqual([
      "myApps",
      "templates",
      "terms",
      "appArtifacts",
      "licenses",
      "environments",
      "inviteCodes",
      "allowList",
    ]);
    expect(fieldsOf(built, "VetraPublisherMutations")).toStrictEqual([
      "addTemplate",
      "setTemplateDetails",
      "addTemplateService",
      "removeTemplateService",
      "addTemplatePackage",
      "removeTemplatePackage",
      "deleteTemplate",
      "addTerm",
      "setTermDetails",
      "publishTerm",
      "retireTerm",
      "issueGrant",
      "replaceGrant",
      "revokeLicense",
      "createInviteCode",
      "setInviteCodeActive",
      "addToAllowList",
      "removeFromAllowList",
    ]);
  });

  it("the publisher surface no longer serves licence types", () => {
    const built = buildASTSchema(schema);
    expect(built.getType("PublisherLicenseType")).toBeUndefined();
    expect(fieldsOf(built, "PublisherEnvironment")).toContain("rootLicenseId");
  });

  it("defines no type name in both documents", () => {
    const machine = new Set(definedNames(machineSchema));
    const clash = definedNames(publisherSchema).filter((n) => machine.has(n));
    expect(clash).toEqual([]);
    const merged = definedNames(schema);
    expect(merged.filter((n, i) => merged.indexOf(n) !== i)).toEqual([]);
  });

  it("registers resolvers only for types the schema defines", () => {
    const built = buildASTSchema(schema);
    // The resolver factories only close over their deps; building them needs
    // no database or reactor, so these are the real key sets.
    const merged = mergeResolvers(
      createResolvers({} as never, { cfg: { enabled: true } } as never) as never,
      createPublisherResolvers({ cfg: { enabled: true } } as never) as never,
    );
    const unknown = Object.keys(merged).filter((k) => !built.getType(k));
    expect(unknown).toEqual([]);
    expect(Object.keys(merged).length).toBeGreaterThan(4);
  });
});
