import type { Action } from "document-model";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppUserEnvironments } from "./db/schema.js";
import {
  renderCreateActions,
  renderUpdateActions,
  templateHash,
  validateTemplate,
  type TemplateShape,
} from "./template.js";

export class LicenseTypeUnavailableError extends Error {
  override name = "LicenseTypeUnavailableError";
}
export class AppEnvironmentCapReachedError extends Error {
  override name = "AppEnvironmentCapReachedError";
}

/**
 * The `template_hash` of a row that owns an environment document whose template
 * has not been applied yet. Never a sha256, so it can never compare equal to a
 * wanted hash: the next call always re-applies against the claimed document
 * instead of creating a second one.
 */
export const UNAPPLIED_TEMPLATE_HASH = "unapplied";

export interface ProvisionDeps {
  findRow(appId: string, user: string): Promise<AppUserEnvironments | null>;
  countForApp(appId: string): Promise<number>;
  maxForApp(appId: string): Promise<number>;
  /**
   * Insert the row if (app_id, user_address) is free, then return whichever row
   * owns that key. Never overwrites an existing claim — this is the lock.
   */
  claimRow(row: AppUserEnvironments): Promise<AppUserEnvironments>;
  /** Must return the row as it landed in storage, which may carry another caller's environment_id. */
  upsertRow(row: AppUserEnvironments): Promise<AppUserEnvironments>;
  envs: {
    create(): Promise<string>;
    execute(environmentId: string, actions: Action[]): Promise<unknown>;
    getState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
    delete(environmentId: string): Promise<void>;
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
 * template validation, such as UnknownTemplateSizeError, propagate unchanged.
 *
 * Claim before act: a freshly created document is written into the row before
 * any action is applied to it, so a rejected action list leaves a document that
 * the next call finds and reuses rather than a document nobody remembers.
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

  // Validation is pure and can throw on a bad template. Do it before creating
  // anything so a bad template cannot leak an orphan environment on every tick.
  validateTemplate(template);

  let row = existing;
  if (!row) {
    const fresh = await deps.envs.create();
    row = await deps.claimRow({
      app_id: input.appId,
      user_address: user,
      environment_id: fresh,
      license_id: input.licenseId,
      template_hash: UNAPPLIED_TEMPLATE_HASH,
      created_at: input.now,
      updated_at: input.now,
    });
    if (row.environment_id !== fresh) {
      // Another caller claimed this (app, user) first. Our document is not
      // referenced by anything, so drop it now rather than orphan it.
      await deps.envs.delete(fresh);
      if (row.template_hash === wanted) return row;
    }
  }

  const environmentId = row.environment_id;
  const state = await deps.envs.getState(environmentId);

  // DRAFT means "created but never initialized", which is also what a claim
  // whose action list was rejected leaves behind — so that retry is a create.
  const actions =
    state && state.status !== "DRAFT"
      ? renderUpdateActions({ label: input.label, template, current: state })
      : renderCreateActions({
          label: input.label,
          subdomain: deps.generateSubdomain(environmentId),
          owner: user,
          template,
        });

  await deps.envs.execute(environmentId, actions);

  return deps.upsertRow({
    app_id: input.appId,
    user_address: user,
    environment_id: environmentId,
    license_id: input.licenseId,
    template_hash: wanted,
    created_at: row.created_at,
    updated_at: input.now,
  });
}
