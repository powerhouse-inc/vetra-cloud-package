import { createHash } from "node:crypto";
import type { Action } from "document-model";
import {
  setLabel,
  initialize,
  setOwner,
  addPackage,
  enableService,
  approveChanges,
  type VetraCloudRessourceSize,
} from "document-models/vetra-cloud-environment";

export interface TemplateService {
  id: string;
  type: "CONNECT" | "SWITCHBOARD" | "CLINT";
  prefix: string | null;
}

export interface TemplatePackage {
  id: string;
  packageName: string | null;
  version: string | null;
}

export interface TemplateShape {
  services: TemplateService[];
  packages: TemplatePackage[];
  size: string | null;
  baseDomain: string | null;
  packageRegistry: string | null;
}

export interface RenderInput {
  label: string;
  subdomain: string;
  owner: string;
  template: TemplateShape;
}

const DEFAULT_BASE_DOMAIN = "vetra.io";

const RESOURCE_SIZES: readonly VetraCloudRessourceSize[] = [
  "VETRA_AGENT_S",
  "VETRA_AGENT_M",
  "VETRA_AGENT_L",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
];

export class UnknownTemplateSizeError extends Error {}

/** null means "no resource size"; any other unrecognised value is an error. */
function asResourceSize(size: string | null): VetraCloudRessourceSize | undefined {
  if (size === null) return undefined;
  const found = RESOURCE_SIZES.find((s) => s === size);
  if (!found) {
    throw new UnknownTemplateSizeError(
      `unknown template size "${size}" — expected one of ${RESOURCE_SIZES.join(", ")}`,
    );
  }
  return found;
}

/**
 * Turn a template into the action list that already builds every environment
 * in this repo (see subgraphs/vetra-apps/service.ts, createApp preview flow).
 * Order matters: initialize before owner, packages before services, approval
 * last.
 */
export function renderTemplateActions(input: RenderInput): Action[] {
  const t = input.template;
  const actions: Action[] = [
    setLabel({ label: input.label }),
    initialize({
      genericSubdomain: input.subdomain,
      genericBaseDomain: t.baseDomain ?? DEFAULT_BASE_DOMAIN,
      defaultPackageRegistry: t.packageRegistry ?? undefined,
    }),
    setOwner({ address: input.owner }),
  ];

  for (const p of t.packages) {
    if (!p.packageName) continue;
    actions.push(
      addPackage({ packageName: p.packageName, version: p.version ?? undefined }),
    );
  }

  const size = asResourceSize(t.size);
  for (const s of t.services) {
    actions.push(
      enableService({
        type: s.type,
        prefix: s.prefix ?? s.type.toLowerCase(),
        ...(s.type === "CLINT" && size ? { selectedRessource: size } : {}),
      }),
    );
  }

  actions.push(approveChanges({}));
  return actions;
}

/**
 * sha256 over a canonical form. Used to recognise an environment whose
 * template has changed since it was provisioned; never for security.
 */
export function templateHash(t: TemplateShape): string {
  const canonical = JSON.stringify({
    baseDomain: t.baseDomain ?? null,
    packageRegistry: t.packageRegistry ?? null,
    size: t.size ?? null,
    packages: [...t.packages]
      .map((p) => ({ n: p.packageName ?? null, v: p.version ?? null }))
      .sort((a, b) => (a.n ?? "").localeCompare(b.n ?? "")),
    services: [...t.services]
      .map((s) => ({ t: s.type, p: s.prefix ?? null }))
      .sort((a, b) => a.t.localeCompare(b.t)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
