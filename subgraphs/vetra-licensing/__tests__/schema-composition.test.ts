import { describe, expect, it } from "vitest";
import {
  buildASTSchema,
  Kind,
  type DocumentNode,
  type GraphQLObjectType,
} from "graphql";
import { machineSchema, schema } from "../schema.js";
import { publisherSchema } from "../publisher-schema.js";

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

  it("also serves the publisher surface", () => {
    const built = buildASTSchema(schema);
    expect(fieldsOf(built, "Query")).toContain("vetraPublisher");
    expect(fieldsOf(built, "Mutation")).toContain("vetraPublisher");
    expect(fieldsOf(built, "VetraPublisherQueries")).toEqual(
      expect.arrayContaining([
        "myApps",
        "licenseTypes",
        "licenses",
        "environments",
      ]),
    );
    expect(fieldsOf(built, "VetraPublisherMutations")).toEqual(
      expect.arrayContaining([
        "createLicenseType",
        "setLicenseTypeTemplate",
        "addLicenseTypeService",
        "addLicenseTypePackage",
        "publishLicenseType",
        "retireLicenseType",
        "issueGrant",
        "revokeLicense",
      ]),
    );
  });

  it("defines no type name in both documents", () => {
    const machine = new Set(definedNames(machineSchema));
    const clash = definedNames(publisherSchema).filter((n) => machine.has(n));
    expect(clash).toEqual([]);
    const merged = definedNames(schema);
    expect(merged.filter((n, i) => merged.indexOf(n) !== i)).toEqual([]);
  });
});
