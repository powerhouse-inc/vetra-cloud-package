/**
 * Admin check for subgraph resolvers.
 *
 * reactor-api verifies the Renown bearer and puts `ctx.user` into subgraph
 * context, but never an `isAdmin` helper: it checks admin-ness itself against
 * the `ADMINS` env (comma-separated addresses). A resolver that relied on
 * `ctx.isAdmin?.()` therefore treated every admin as a stranger. This reads
 * the same env, and still defers to `ctx.isAdmin` if a host ever provides one.
 */
export function callerIsAdmin(
  ctx: { isAdmin?: (address: string) => boolean },
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  if (ctx.isAdmin) return ctx.isAdmin(address);
  const admins = (process.env.ADMINS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(address.toLowerCase());
}
