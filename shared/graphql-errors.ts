import { GraphQLError, type GraphQLResolveInfo } from "graphql";

/**
 * Keep server stack traces out of GraphQL responses.
 *
 * The Switchboard runs with NODE_ENV=development (deliberately, see hosting
 * commit 79652843), and the reactor-api builds its ApolloServer without
 * `includeStacktraceInErrorResponses`, so Apollo answers every error with
 * `extensions.stacktrace = error.stack.split("\n")` — file paths of the
 * Switchboard image, the package bundle and node_modules included. Neither
 * the reactor-api nor the Switchboard reads an env var to turn that off.
 *
 * What a subgraph controls is the error its resolvers throw. graphql-js
 * locates a resolver error by wrapping it in a new GraphQLError (with path
 * and locations) that copies `stack` from it, and Apollo prints that `stack`.
 * So every resolver error is rethrown as a GraphQLError whose stack is only
 * its first line ("GraphQLError: <message>"): no frames, no paths. The error
 * the resolver threw stays in `originalError`, its real stack intact for the
 * server's own logs.
 *
 * The rethrown error is deliberately left unlocated (no `path`): the
 * Switchboard's graphql-js then does the locating, so path and locations
 * stay right even when this package and the Switchboard load different
 * copies of graphql (Apollo re-wraps an error of a foreign GraphQLError
 * class without them). And a one-line stack, unlike an empty one, is
 * copied as is: graphql-js only captures a fresh trace when it is empty.
 *
 * Messages, codes and other extensions are unchanged.
 */
export function stackFreeError(error: unknown): GraphQLError {
  let clean: GraphQLError;
  if (error instanceof GraphQLError) {
    clean = new GraphQLError(error.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: error.originalError ?? error,
      extensions: error.extensions,
    });
  } else if (error instanceof Error) {
    clean = new GraphQLError(error.message, { originalError: error });
  } else {
    clean = new GraphQLError(`Unexpected error value: ${String(error)}`);
  }
  Object.defineProperty(clean, "stack", {
    value: `GraphQLError: ${clean.message}`,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return clean;
}

type Resolver = (
  this: unknown,
  parent: unknown,
  args: unknown,
  context: unknown,
  info: GraphQLResolveInfo,
) => unknown;

const WRAPPED = Symbol.for("vetra.stackFreeResolver");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function wrapResolver(fn: Resolver): Resolver {
  if ((fn as unknown as Record<symbol, unknown>)[WRAPPED]) return fn;
  const wrapped: Resolver = function (this: unknown, parent, args, ctx, info) {
    let result: unknown;
    try {
      result = fn.call(this, parent, args, ctx, info);
    } catch (error) {
      throw stackFreeError(error);
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).catch((error: unknown) => {
        throw stackFreeError(error);
      });
    }
    return result;
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped;
}

/**
 * Wrap every field resolver of a subgraph resolver map (Query, Mutation,
 * object-type fields, `{ resolve, subscribe }` field configs) so the errors
 * they throw or reject with reach the client without a stack trace (see
 * stackFreeError). Scalars, enums and `__`-prefixed hooks (__resolveType,
 * __resolveReference, ...) are left alone. Returns a new map; idempotent.
 */
export function withoutStacktraces<T extends Record<string, unknown>>(
  resolvers: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [typeName, fields] of Object.entries(resolvers)) {
    if (!isPlainObject(fields)) {
      out[typeName] = fields;
      continue;
    }
    const wrappedFields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (field.startsWith("__")) {
        wrappedFields[field] = value;
      } else if (typeof value === "function") {
        wrappedFields[field] = wrapResolver(value as Resolver);
      } else if (isPlainObject(value)) {
        const config: Record<string, unknown> = { ...value };
        for (const key of ["resolve", "subscribe"] as const) {
          if (typeof config[key] === "function") {
            config[key] = wrapResolver(config[key] as Resolver);
          }
        }
        wrappedFields[field] = config;
      } else {
        wrappedFields[field] = value;
      }
    }
    out[typeName] = wrappedFields;
  }
  return out as T;
}
