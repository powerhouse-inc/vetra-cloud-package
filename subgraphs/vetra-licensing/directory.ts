import type { AppDocView } from "./app-reads.js";
import type { AppIdentity } from "./app-identity.js";

/**
 * The public app directory (vetraSubscriptions.directory): every app you can
 * get, ranked by how many people hold it. Counts only; no holder is named.
 */
export interface DirectoryApp {
  appId: string;
  name: string;
  /** The app's identity, which its Renown profile is keyed by; null without one. */
  appDid: string | null;
  /** Distinct users holding an ACTIVE licence. */
  holders: number;
  /** Published (ACTIVE) plans. */
  plans: number;
}

export interface DirectoryDeps {
  /** Trusted app ids: the apps rows and the studio app. */
  appIds(): Promise<ReadonlySet<string>>;
  app(id: string): Promise<Pick<AppDocView, "id" | "name" | "status" | "tampered" | "terms"> | null>;
  /** The apps row's identity and status; null for an app without one. */
  identity(appId: string): Promise<AppIdentity | null>;
  /** The app's authorised licences, statuses as recorded. */
  licencesOf(appId: string): Promise<{ userDid: string; status: string }[]>;
}

export async function appDirectory(deps: DirectoryDeps): Promise<DirectoryApp[]> {
  const out: DirectoryApp[] = [];
  for (const id of await deps.appIds()) {
    const app = await deps.app(id);
    // A tampered document's terms are untrusted: it lists nothing.
    if (!app || app.tampered || app.status === "DELETED") continue;
    const plans = app.terms.filter((t) => t.status === "ACTIVE").length;
    if (plans === 0) continue;
    const identity = await deps.identity(id);
    if (identity?.status === "DELETED") continue;
    const holders = new Set(
      (await deps.licencesOf(id)).filter((l) => l.status === "ACTIVE").map((l) => l.userDid),
    ).size;
    out.push({ appId: id, name: app.name ?? id, appDid: identity?.identityDid ?? null, holders, plans });
  }
  return out.sort((a, b) => b.holders - a.holders || a.name.localeCompare(b.name));
}

/**
 * The last good result of `read` for `ttlMs`: the directory is public, and one
 * listing reads every app document. A failed read is not kept.
 */
export function cachedFor<T>(ttlMs: number, now: () => number, read: () => Promise<T>): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  return async () => {
    if (last && now() - last.at < ttlMs) return last.value;
    const value = await read();
    last = { at: now(), value };
    return value;
  };
}
