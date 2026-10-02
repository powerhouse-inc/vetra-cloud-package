/**
 * FUSION auto-deploy: environments whose FUSION service has
 * `fusion.autoUpdate` follow the newest Harbor tag of their image that matches
 * `fusion.autoUpdateTagPattern` (default `^sha-[0-9a-f]{7,40}$`). App repos
 * only push images; nothing in their CI needs a platform credential.
 */

export const DEFAULT_FUSION_TAG_PATTERN = "^sha-[0-9a-f]{7,40}$";
export const FUSION_AUTO_UPDATE_INTERVAL_MS = 120_000;

/**
 * Only settled envs are bumped: bumping approves, and approving a DRAFT or
 * CHANGES_PENDING env would ship the owner's unapproved edits. In-flight
 * deploys and sleeping/released envs catch up on a later tick.
 */
const BUMPABLE_STATUSES = new Set(["READY", "DEPLOYMENt_FAILED"]);

export type HarborArtifact = {
  push_time: string;
  tags: { name: string }[] | null;
};

export type FusionEnvRow = {
  id: string;
  name: string | null;
  tenantId: string | null;
  status: string | null;
  services: string | null;
  fusion: string | null;
  /** Set for Vetra App envs (state.app): those deploy only via deployApp. */
  appId?: string | null;
};

type FusionConfig = {
  image: string | null;
  autoUpdate: boolean;
  autoUpdateTagPattern: string | null;
};

export function pickNewestTag(
  artifacts: HarborArtifact[],
  pattern: RegExp,
): string | null {
  let best: { at: number; tag: string } | null = null;
  for (const a of artifacts) {
    const tag = (a.tags ?? []).map((t) => t.name).find((n) => pattern.test(n));
    if (!tag) continue;
    const at = Date.parse(a.push_time);
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { at, tag };
  }
  return best?.tag ?? null;
}

/** Harbor v2 artifacts URL for `cr.vetra.io/<project>/<repo…>`, newest first. */
export function harborArtifactsUrl(image: string): string {
  const [host, project, ...repo] = image.split("/");
  // Harbor needs nested repository names double-encoded (a/b → a%252Fb).
  const repoPath = encodeURIComponent(encodeURIComponent(repo.join("/")));
  return `https://${host}/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${repoPath}/artifacts?sort=-push_time&page_size=20&with_tag=true`;
}

export function createHarborArtifactLister(creds: {
  username: string;
  password: string;
}): (image: string) => Promise<HarborArtifact[]> {
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
  return async (image) => {
    const res = await fetch(harborArtifactsUrl(image), {
      headers: { authorization: auth, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`harbor ${res.status} for ${image}`);
    return (await res.json()) as HarborArtifact[];
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function runFusionAutoUpdateOnce(deps: {
  listEnvs: () => Promise<FusionEnvRow[]>;
  listArtifacts: (image: string) => Promise<HarborArtifact[]>;
  bump: (env: FusionEnvRow, tag: string) => Promise<boolean>;
}): Promise<string[]> {
  const bumped: string[] = [];
  for (const env of await deps.listEnvs()) {
    if (!env.status || !BUMPABLE_STATUSES.has(env.status)) continue;
    if (env.appId) continue; // App envs deploy explicitly (deployApp)
    const fusion = parseJson<FusionConfig>(env.fusion);
    if (!fusion?.autoUpdate || !fusion.image) continue;
    const service = (
      parseJson<Array<{ type: string; enabled: boolean; version: string | null }>>(
        env.services,
      ) ?? []
    ).find((s) => s.type === "FUSION" && s.enabled);
    if (!service) continue;

    let pattern: RegExp;
    try {
      pattern = new RegExp(fusion.autoUpdateTagPattern || DEFAULT_FUSION_TAG_PATTERN);
    } catch {
      continue;
    }
    try {
      const tag = pickNewestTag(await deps.listArtifacts(fusion.image), pattern);
      if (!tag || tag === service.version) continue;
      if (await deps.bump(env, tag)) bumped.push(env.id);
    } catch (err) {
      console.warn(
        `[fusion-auto-update] ${env.name ?? env.id}: ${String(err)}`,
      );
    }
  }
  return bumped;
}
