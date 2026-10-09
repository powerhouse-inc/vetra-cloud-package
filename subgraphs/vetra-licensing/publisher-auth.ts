import { callerIsAdmin } from "../../shared/admins.js";
import {
  UnauthenticatedError,
  AppIdentityInactiveError,
  type AuthContext,
} from "./auth.js";

// `name` is deliberately the SAME on both classes (and the message is fixed and
// does not echo the id): a client must not be able to tell "not yours" from
// "does not exist". Do not "fix" it back to the class name. The classes stay
// distinct for instanceof, and server-side logs can still tell them apart via
// err.constructor.name, which no error formatter serialises.
export class NotAppOwnerError extends Error {
  override name = "UnknownAppError";
}
export class UnknownAppError extends Error {
  override name = "UnknownAppError";
}

export interface OwnerAppRecord {
  id: string;
  name: string;
  status: string;
  owner_address: string;
  /** The app's Renown workload identity (did:key); absent/null before one exists. */
  identity_did?: string | null;
}

export interface PublisherAuthDeps {
  findAppById(id: string): Promise<OwnerAppRecord | null>;
  listAppsForOwner(address: string): Promise<OwnerAppRecord[]>;
}

/**
 * The human counterpart to resolveCallerApp. A person proves who they are with
 * a wallet, then proves the app is theirs. The app id IS an argument here --
 * the opposite of the machine surface -- which is only safe because ownership
 * is checked on every single call.
 */
export async function resolveOwnerApp(
  deps: PublisherAuthDeps,
  ctx: AuthContext & { isAdmin?: (a: string) => boolean },
  appId: string,
): Promise<{ appId: string }> {
  const address = ctx.user?.address;
  if (!address) {
    throw new UnauthenticatedError("sign in to manage licences");
  }

  const app = await deps.findAppById(appId);
  if (!app) {
    throw new UnknownAppError("no such app");
  }

  const isOwner = app.owner_address.toLowerCase() === address.toLowerCase();
  if (!isOwner && !callerIsAdmin(ctx, address)) {
    throw new NotAppOwnerError("no such app");
  }

  if (app.status !== "ACTIVE") {
    throw new AppIdentityInactiveError(
      `app ${app.id} is ${app.status}; its identity delegation must be renewed`,
    );
  }

  return { appId: app.id };
}
