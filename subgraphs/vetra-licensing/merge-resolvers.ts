type ResolverMap = Record<string, Record<string, unknown>>;

/**
 * Merge the machine and publisher resolver maps. Both carry Query and
 * Mutation, so a shallow spread would let the second silently replace the
 * first's root field; those two are merged one level down. Every other key is
 * namespaced and distinct.
 */
export function mergeResolvers(a: ResolverMap, b: ResolverMap): ResolverMap {
  return {
    ...a,
    ...b,
    Query: { ...a.Query, ...b.Query },
    Mutation: { ...a.Mutation, ...b.Mutation },
  };
}
