import type { Action } from "document-model";
import type { AppUserEnvironments } from "./db/schema.js";
import {
  renderTemplateActions,
  templateHash,
  type TemplateShape,
} from "./template.js";

export class LicenseTypeUnavailableError extends Error {}
export class AppEnvironmentCapReachedError extends Error {}

export interface ProvisionDeps {
  findRow(appId: string, user: string): Promise<AppUserEnvironments | null>;
  countForApp(appId: string): Promise<number>;
  maxForApp(appId: string): Promise<number>;
  /** Must return the row as it landed in storage, which may carry another caller's environment_id. */
  upsertRow(row: AppUserEnvironments): Promise<AppUserEnvironments>;
  envs: {
    create(): Promise<string>;
    execute(environmentId: string, actions: Action[]): Promise<unknown>;
  };
  generateSubdomain(environmentId: string): string;
}

export interface ApplyInput {
  appId: string;
  user: string;
  licenseId: string;
  /** null when the licence type is missing or RETIRED. */
  template: TemplateShape | null;
  label: string;
  now: string;
}

/**
 * Ensure exactly one environment exists for (appId, user), matching the
 * template. Idempotent: called twice with the same arguments the second call
 * does nothing, so a reconcile handler can call it every tick unguarded.
 *
 * A null template refuses (the existing environment is left untouched;
 * releasing it is the caller's decision). The per-app cap applies only when
 * creating, never to a user who already has an environment. Errors from
 * template rendering, such as UnknownTemplateSizeError, propagate unchanged.
 */
export async function applyEnvironmentTemplate(
  deps: ProvisionDeps,
  input: ApplyInput,
): Promise<AppUserEnvironments> {
  const { template } = input;
  if (!template) {
    throw new LicenseTypeUnavailableError(
      `license ${input.licenseId} has no usable template; leaving any existing environment alone`,
    );
  }

  const user = input.user.toLowerCase();
  const wanted = templateHash(template);
  const existing = await deps.findRow(input.appId, user);

  if (existing && existing.template_hash === wanted) {
    return existing;
  }

  if (!existing) {
    const [count, max] = await Promise.all([
      deps.countForApp(input.appId),
      deps.maxForApp(input.appId),
    ]);
    if (count >= max) {
      throw new AppEnvironmentCapReachedError(
        `app ${input.appId} is at its ceiling of ${max} environments`,
      );
    }
  }

  const render = (subdomain: string) =>
    renderTemplateActions({ label: input.label, subdomain, owner: user, template });

  // Rendering is pure and can throw on a bad template. Do it before creating
  // anything so a bad template cannot leak an orphan environment on every tick.
  render("");

  const environmentId = existing?.environment_id ?? (await deps.envs.create());
  await deps.envs.execute(
    environmentId,
    render(deps.generateSubdomain(environmentId)),
  );

  return deps.upsertRow({
    app_id: input.appId,
    user_address: user,
    environment_id: environmentId,
    license_id: input.licenseId,
    template_hash: wanted,
    created_at: existing?.created_at ?? input.now,
    updated_at: input.now,
  });
}
