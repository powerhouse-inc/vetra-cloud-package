import { GraphQLError } from "graphql";
import { createPublisherResolvers as create } from "../publisher-resolvers.js";

type Field = (...a: unknown[]) => Promise<unknown>;

/**
 * createPublisherResolvers with each field's GraphQLError unwrapped back to the
 * original licensing error. Production wraps every field so the browser gets an
 * extensions.code (see publisher-errors.test.ts); the suites using this helper
 * assert on resolver LOGIC, i.e. which domain error was raised, so they match on
 * the original class. The wrapping itself is covered only in
 * publisher-errors.test.ts.
 */
export const createPublisherResolvers = ((
  ...args: Parameters<typeof create>
) => {
  const r = create(...args) as Record<string, Record<string, Field>>;
  for (const group of ["VetraPublisherQueries", "VetraPublisherMutations"]) {
    for (const [name, fn] of Object.entries(r[group])) {
      r[group][name] = async (...a) => {
        try {
          return await fn(...a);
        } catch (err) {
          throw err instanceof GraphQLError && err.originalError
            ? err.originalError
            : err;
        }
      };
    }
  }
  return r;
}) as typeof create;
