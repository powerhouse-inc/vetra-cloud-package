import type { EnvGateway } from "../vetra-apps/envs.js";
import type { WarmPoolStore } from "./warm-pool-db.js";
import { renderCreateActions, type TemplateShape } from "./template.js";

export interface WarmEnvDeps {
  envs: EnvGateway;
  /** Protects the new document for the Vetra service identity. */
  protect(documentId: string): Promise<void>;
  generateSubdomain(id: string): string;
  store: WarmPoolStore;
  /** Defaults to console. */
  logger?: { warn(msg: string, ...args: unknown[]): void };
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
 * env is auto-claimed by the first user-signed action). The WARMING row is
 * inserted before the actions: they approve the changes, and the gitops render
 * that follows must already see the environment as warm (ingress closed, the
 * App's image allowed). On any failure the row is marked deleted, the document
 * deleted and the original error rethrown.
 */
export async function createWarmEnvironment(
  deps: WarmEnvDeps,
  input: WarmEnvInput,
): Promise<string> {
  const id = await deps.envs.create();
  const logger = deps.logger ?? console;
  let inserted = false;
  try {
    await deps.protect(id);
    await deps.store.insertWarming({
      environmentId: id,
      appId: input.appId,
      templateId: input.template.id,
      templateHash: input.templateHash,
      nowIso: input.nowIso,
    });
    inserted = true;
    const actions = renderCreateActions({
      owner: null,
      label: `${input.appName} (warm)`,
      subdomain: deps.generateSubdomain(id),
      template: input.template,
    });
    await deps.envs.execute(id, actions);
    return id;
  } catch (err) {
    if (inserted) {
      await deps.store.markDeleted(id, input.nowIso).catch((dbErr: unknown) => {
        logger.warn(
          `[warm-pool] could not retire the warm-pool row of ${id} after a failed create`,
          id,
          dbErr,
        );
      });
    }
    await deps.envs.delete(id).catch((delErr: unknown) => {
      logger.warn(
        `[warm-pool] could not delete warm environment ${id} after a failed create; it is orphaned`,
        id,
        delErr,
      );
    });
    throw err;
  }
}
