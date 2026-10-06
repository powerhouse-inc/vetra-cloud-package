export class UnauthenticatedError extends Error {}
export class UnknownAppIdentityError extends Error {}
export class AppIdentityInactiveError extends Error {}

export interface AuthContext {
  user?: {
    address: string;
    networkId: string;
    chainId: number;
    /** The App's did:key, set by reactor-api when the bearer is an App delegation. */
    appKey?: string;
  };
}

export interface AppRecord {
  id: string;
  status: string;
}

export interface AuthDeps {
  findAppByIdentityDid(did: string): Promise<AppRecord | null>;
}

/**
 * The caller is an App identity, never a person. The app id is taken from the
 * delegation, never from an argument, so no app can name another app's id.
 *
 * `apps.identity_did` holds the App's did:key, which reactor-api surfaces as
 * `user.appKey`. When it is present it is the only thing looked up; otherwise
 * the did:pkh of the signing address is tried (it will not match a did:key, so
 * a plain person fails closed with UnknownAppIdentityError).
 */
export async function resolveCallerApp(
  deps: AuthDeps,
  ctx: AuthContext,
): Promise<{ appId: string }> {
  const u = ctx.user;
  if (!u) {
    throw new UnauthenticatedError("a license call must carry an app identity");
  }

  const did =
    u.appKey ?? `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
  const app = await deps.findAppByIdentityDid(did);
  if (!app) {
    throw new UnknownAppIdentityError(`no app is registered for ${did}`);
  }
  if (app.status !== "ACTIVE") {
    throw new AppIdentityInactiveError(
      `app ${app.id} is ${app.status}; its identity delegation must be renewed`,
    );
  }

  return { appId: app.id };
}
