import { isStudioPackagesJson } from "../../shared/studio-package.js";
import { redactSecrets } from "../../shared/redact.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import { didForAddress } from "../vetra-licensing/did.js";
import type { StudioLlmBudget } from "../vetra-licensing/studio-access.js";
import { STUDIO_KEY_SECRET_NAMES } from "../vetra-licensing/subscriptions-resolvers.js";
import type { ProvisionResult } from "./broker.js";

const RELEASED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

export interface ClaimedStudio {
  id: string;
  tenantId: string;
  /** Lowercased owner address. */
  owner: string;
}

/** Owned, live Studio rows of the environments projection (warm pool envs are owner-null). */
export function claimedStudiosFrom(
  rows: Array<{
    id: string;
    tenantId: string | null;
    owner: string | null;
    status: string | null;
    packages: string | null;
  }>,
): ClaimedStudio[] {
  return rows.flatMap((r) =>
    r.owner &&
    r.tenantId &&
    !(r.status && RELEASED_STATUSES.has(r.status)) &&
    isStudioPackagesJson(r.packages)
      ? [{ id: r.id, tenantId: r.tenantId, owner: r.owner.toLowerCase() }]
      : [],
  );
}

export interface MigrationDeps {
  listClaimedStudios(): Promise<ClaimedStudio[]>;
  budgetForDid(did: string): Promise<StudioLlmBudget>;
  provision(input: {
    environmentId: string;
    tenantId: string;
    ownerDid: string;
  }): Promise<ProvisionResult>;
  secrets: Pick<SecretsService, "deleteSecret"> | null;
  logger: Pick<Console, "info" | "warn" | "error">;
}

export interface MigrationReport {
  dryRun: boolean;
  scanned: number;
  /** Provisioned (or, in a dry run, would be). */
  provisioned: string[];
  /** Usable licence, budget 0: connect-a-model mode. */
  noBudget: string[];
  /** No usable studio licence: the sweeper leaves them alone, the card says connect a model. */
  noLicence: string[];
  failed: string[];
  anthropicSecretsRemoved: number;
}

/**
 * Cut-over (spec "Migration and cut-over"):
 * - step 2: give every live, claimed Studio with a usable licence its Vetra
 *   key; the Anthropic secrets stay, so both are present;
 * - step 4 (`removeAnthropicSecrets`, after verification): delete the three
 *   Anthropic secret names.
 *
 * Idempotent: provisioning reuses an env's key, and a missing secret is a no-op.
 */
export async function migrateStudiosToOpenRouter(
  d: MigrationDeps,
  opts: { dryRun: boolean; removeAnthropicSecrets: boolean },
): Promise<MigrationReport> {
  const report: MigrationReport = {
    dryRun: opts.dryRun,
    scanned: 0,
    provisioned: [],
    noBudget: [],
    noLicence: [],
    failed: [],
    anthropicSecretsRemoved: 0,
  };
  for (const s of await d.listClaimedStudios()) {
    report.scanned += 1;
    try {
      const ownerDid = didForAddress(s.owner);
      const budget = await d.budgetForDid(ownerDid);
      if (!budget.allowed) report.noLicence.push(s.id);
      else if (budget.budgetUsd <= 0) report.noBudget.push(s.id);
      else if (opts.dryRun) report.provisioned.push(s.id);
      else {
        const res = await d.provision({
          environmentId: s.id,
          tenantId: s.tenantId,
          ownerDid,
        });
        (res.connected ? report.provisioned : report.noBudget).push(s.id);
      }
      if (opts.removeAnthropicSecrets && !opts.dryRun && d.secrets) {
        for (const name of STUDIO_KEY_SECRET_NAMES) {
          if (await d.secrets.deleteSecret(s.tenantId, name))
            report.anthropicSecretsRemoved += 1;
        }
      }
    } catch (err) {
      report.failed.push(s.id);
      d.logger.warn(
        `[vetra-llm] migrate ${s.id} failed: ${redactSecrets(String(err))}`,
      );
    }
  }
  d.logger.info(
    `[vetra-llm] migrateStudiosToOpenRouter: ${JSON.stringify(report)}`,
  );
  return report;
}
