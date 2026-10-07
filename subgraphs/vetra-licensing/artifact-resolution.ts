import type { AppArtifact } from "./reads.js";
import type { TemplateShape } from "./template.js";

export class UnresolvableArtifactError extends Error {
  override name = "UnresolvableArtifactError";
}

/** The channel a service follows when the template names an artifact but no channel. */
const DEFAULT_CHANNEL = "LATEST";

/**
 * Replaces every artifact reference in a template with the concrete version the
 * channel currently points at.
 *
 * This is what makes decision 2 work. A template stores `dtbau-psb@LATEST`, and
 * that text does not change when 1.3.0 publishes — so a hash taken over the
 * template itself would never move and no holder would ever be re-provisioned.
 * Hashing the RESOLVED set instead means a publish changes the hash, which is
 * what the keeper notices.
 *
 * Throws when a reference cannot be resolved. The caller holds the licence
 * rather than provisioning something arbitrary: an environment running last
 * week's image because this week's is missing is worse than one that waits.
 */
export function resolveTemplateArtifacts(
  template: TemplateShape,
  artifacts: AppArtifact[],
): TemplateShape {
  const services = template.services.map((s) => {
    if (!s.artifactName) return s;

    const artifact = artifacts.find(
      (a) => a.kind === "FUSION_IMAGE" && a.name === s.artifactName,
    );
    if (!artifact) {
      throw new UnresolvableArtifactError(
        `template names image "${s.artifactName}", which this app has not published`,
      );
    }

    const channel = s.artifactChannel ?? DEFAULT_CHANNEL;
    const pointer = artifact.channels.find((c) => c.channel === channel);
    if (!pointer) {
      throw new UnresolvableArtifactError(
        `image "${s.artifactName}" has no ${channel} build yet`,
      );
    }
    // A channel pointing at a version the catalogue no longer lists is the
    // yanked-version case: refuse rather than run something unverified.
    const published = artifact.versions.find(
      (v) => v.version === pointer.version,
    );
    if (!published) {
      throw new UnresolvableArtifactError(
        `image "${s.artifactName}" ${channel} points at ${pointer.version}, which is no longer published`,
      );
    }

    return {
      ...s,
      resolvedVersion: pointer.version,
      resolvedRepository: repositoryOf(published.reference),
    };
  });

  return { ...template, services };
}

/**
 * The repository half of an image reference. SET_FUSION_CONFIG takes the
 * repository alone and refuses a tag or digest — the service's version picks
 * the tag — so `cr.vetra.io/p/app:1.2.3` has to become `cr.vetra.io/p/app`.
 */
export function repositoryOf(reference: string): string {
  const atDigest = reference.split("@")[0]!;
  const lastSlash = atDigest.lastIndexOf("/");
  const colon = atDigest.indexOf(":", lastSlash + 1);
  return colon === -1 ? atDigest : atDigest.slice(0, colon);
}

/** True when anything in this template has to be resolved before it can be used. */
export function templateNeedsArtifacts(template: TemplateShape): boolean {
  return template.services.some((s) => Boolean(s.artifactName));
}
