import {
  resolveKind,
  type AppDocView,
  type AppTemplateView,
  type KindResolution,
} from "./app-reads.js";
import {
  resolveTemplateArtifacts,
  templateNeedsArtifacts,
} from "./artifact-resolution.js";
import { templateHash } from "./template.js";

/** The channel a canary environment follows instead of its template's (spec 4.2). */
export const CANARY_CHANNEL = "STAGING";

/** The template with every artifact resolved on `channel`; a failure is its resolutionError, as for the template's own. */
function onChannel(
  t: AppTemplateView,
  app: AppDocView,
  channel: string,
): AppTemplateView {
  if (!templateNeedsArtifacts(t.template)) return t;
  try {
    const template = resolveTemplateArtifacts(
      t.template,
      app.artifacts,
      channel,
    );
    return {
      ...t,
      template,
      templateHash: templateHash(template),
      resolutionError: null,
    };
  } catch (err) {
    return {
      ...t,
      resolutionError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * resolveKind for one chain. A chain whose environment carries a channel
 * override (license_environments.channel_override: a canary) resolves every
 * artifact reference on that channel, and its hash is taken over that
 * resolved set, so it re-templates when the channel moves. Without one, this
 * is resolveKind.
 */
export function resolveChainKind(
  app: AppDocView,
  kind: string | null,
  channel: string | null,
): KindResolution {
  if (!channel) return resolveKind(app, kind);
  return resolveKind(
    { ...app, templates: app.templates.map((t) => onChannel(t, app, channel)) },
    kind,
  );
}
