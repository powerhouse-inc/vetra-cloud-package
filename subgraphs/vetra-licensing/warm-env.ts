import type { EnvGateway } from "../vetra-apps/envs.js";
import type { WarmPoolStore } from "./warm-pool-db.js";
import { renderCreateActions, type TemplateShape } from "./template.js";

export interface WarmEnvDeps {
  envs: EnvGateway;
  /** Protects the new document for the Vetra service identity. */
  protect(documentId: string): Promise<void>;
  generateSubdomain(id: string): string;
  store: WarmPoolStore;
}

export interface WarmEnvInput {
  appId: string;
  appName: string;
  template: TemplateShape & { id: string };
  templateHash: string;
  nowIso: string;
}

/**
 * Create an ownerless environment from the App's template so a later licence
 * can claim it. Protection happens before any action is applied (an unowned
 * env is auto-claimed by the first user-signed action). On any failure the
 * document is deleted and the error rethrown; the WARMING row is inserted
 * only once the actions succeeded.
 */
export async function createWarmEnvironment(
  deps: WarmEnvDeps,
  input: WarmEnvInput,
): Promise<string> {
  const id = await deps.envs.create();
  try {
    await deps.protect(id);
    const actions = renderCreateActions({
      owner: null,
      label: `${input.appName} (warm)`,
      subdomain: deps.generateSubdomain(id),
      template: input.template,
    });
    await deps.envs.execute(id, actions);
    await deps.store.insertWarming({
      environmentId: id,
      appId: input.appId,
      templateId: input.template.id,
      templateHash: input.templateHash,
      nowIso: input.nowIso,
    });
    return id;
  } catch (err) {
    await deps.envs.delete(id).catch(() => {});
    throw err;
  }
}
