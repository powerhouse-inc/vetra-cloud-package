/**
 * Owner-only auth predicate for the explorer surface.
 *
 * Re-exports `requireOwner` from the dumps module rather than duplicating
 * it: the security model is identical (owner-only, FORBIDDEN otherwise),
 * and keeping a single helper means a change to the auth rules (e.g.
 * admin override) lands in one place.
 */
export { requireOwner } from "../dumps/auth.js";
export type { RequireOwnerInput } from "../dumps/auth.js";
