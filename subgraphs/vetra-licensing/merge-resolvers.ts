type ResolverMap = Record<string, Record<string, unknown>>;

/**
 * Merge the machine and publisher resolver maps. Both carry Query and
 * Mutation, so a shallow spread would let the second silently replace the
 * first's root field; those two are merged one level down. Every other key is
 * namespaced and distinct, and a collision on one THROWS: silently letting one
 * side replace a whole type's resolvers would drop a namespace unnoticed.
 */
export function mergeResolvers(a: ResolverMap, b: ResolverMap): ResolverMap {
  for (const k of Object.keys(b)) {
    if (k !== "Query" && k !== "Mutation" && k in a) {
      throw new Error(`resolver key "${k}" is defined by both resolver maps`);
    }
  }
  return {
    ...a,
    ...b,
    Query: { ...a.Query, ...b.Query },
    Mutation: { ...a.Mutation, ...b.Mutation },
  };
}
