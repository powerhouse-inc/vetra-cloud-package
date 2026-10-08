import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildASTSchema,
  isEnumType,
  isInputObjectType,
  isObjectType,
  parse,
  print,
  Kind,
  type DefinitionNode,
  type GraphQLArgument,
  type GraphQLNamedType,
  type GraphQLSchema,
} from "graphql";
import { describe, expect, it } from "vitest";
import { schema } from "../schema.js";

const CONTRACT = fileURLToPath(
  new URL(
    "../../../docs/superpowers/specs/2026-10-08-licensing-api-contract.md",
    import.meta.url,
  ),
);

const SECTIONS = ["vetraPublisher", "vetraSubscriptions", "vetraLicensing"];

/** The fenced graphql blocks under a `## <heading>` section of the contract. */
function sdlOf(markdown: string, heading: string): string {
  const start = markdown.search(new RegExp(`^## ${heading}\\b`, "m"));
  if (start === -1) throw new Error(`contract has no "${heading}" section`);
  const rest = markdown.slice(start + 3);
  const next = rest.search(/^## /m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return [...body.matchAll(/```graphql\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");
}

// `Subscription` is a contract type name, and also GraphQL's default
// subscription root. Name the roots explicitly so it stays an ordinary type.
const ROOTS = parse("schema { query: Query mutation: Mutation }");

function servedSchema(): GraphQLSchema {
  return buildASTSchema({
    kind: Kind.DOCUMENT,
    definitions: [...ROOTS.definitions, ...schema.definitions] as DefinitionNode[],
  });
}

function fieldShapes(type: GraphQLNamedType): Map<string, string> {
  const out = new Map<string, string>();
  if (isObjectType(type) || isInputObjectType(type)) {
    for (const f of Object.values(type.getFields())) {
      const fieldArgs: readonly GraphQLArgument[] = "args" in f ? f.args : [];
      const args =
        fieldArgs.length > 0
          ? `(${fieldArgs.map((a) => `${a.name}: ${String(a.type)}`).join(", ")})`
          : "";
      out.set(f.name, `${f.name}${args}: ${String(f.type)}`);
    }
  }
  return out;
}

describe("licensing API contract parity", () => {
  const markdown = readFileSync(CONTRACT, "utf8");
  const served = servedSchema();

  for (const section of SECTIONS) {
    it(`${section}: every contract type and field is served identically`, () => {
      const contract = parse(sdlOf(markdown, section));
      const problems: string[] = [];
      let checked = 0;

      for (const def of contract.definitions) {
        if (
          def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
          def.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION &&
          def.kind !== Kind.ENUM_TYPE_DEFINITION
        ) {
          continue;
        }
        const name = def.name.value;
        const type = served.getType(name);
        if (!type) {
          problems.push(`type ${name} is not served`);
          continue;
        }
        if (def.kind === Kind.ENUM_TYPE_DEFINITION) {
          const want = (def.values ?? []).map((v) => v.name.value).sort();
          const have = isEnumType(type) ? type.getValues().map((v) => v.name).sort() : [];
          if (want.join() !== have.join()) problems.push(`enum ${name} values differ`);
          continue;
        }
        const have = fieldShapes(type);
        for (const f of def.fields ?? []) {
          checked++;
          const args =
            "arguments" in f && f.arguments && f.arguments.length > 0
              ? `(${f.arguments.map((a) => `${a.name.value}: ${print(a.type)}`).join(", ")})`
              : "";
          const want = `${f.name.value}${args}: ${print(f.type)}`;
          const got = have.get(f.name.value);
          if (got !== want) problems.push(`${name}.${f.name.value}: contract \`${want}\`, served \`${got ?? "missing"}\``);
        }
      }

      expect(checked).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    });
  }
});
