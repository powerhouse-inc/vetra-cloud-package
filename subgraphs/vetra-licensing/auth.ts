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
 * The caller is an App identity presenting its did:key (`user.appKey`), never a
 * person: a human wallet address is not an accepted identity here. The app id
 * is taken from that identity, never from an argument, so no app can name
 * another app's id. There is exactly one way to authenticate.
 */
export async function resolveCallerApp(
  deps: AuthDeps,
  ctx: AuthContext,
): Promise<{ appId: string }> {
  const did = ctx.user?.appKey;
  if (!did) {
    throw new UnauthenticatedError("a license call must carry an app identity");
  }

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
