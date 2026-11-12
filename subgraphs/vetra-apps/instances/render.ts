import type { Action } from "document-model";
import {
  enableService,
  initialize,
  setApexService,
  setAppLink,
  setFusionConfig,
  setLabel,
  setOwner,
  setOwnerOrg,
  setServiceVersion,
  wakeEnvironment,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { WORKFLOWS_MASTER_KEY } from "../../vetra-cloud-secrets/services/secrets-service.js";
import {
  SETTINGS_REVISION_ENV,
  VETRA_GENERATED_SECRETS,
} from "../settings/names.js";
import type { InstanceSettings } from "../settings/resolve.js";

/** What an instance runs: repository (no tag), `<version>@<digest>`, and its host (PH_HOST). */
export interface InstanceImage {
  repository: string;
  tag: string;
  phHost: string;
}

export const imageTag = (version: string, digest: string) => {
  if (!version)
    throw new Error(`An instance image needs a version (digest ${digest})`);
  return `${version}@${digest}`;
};

/** A tag must carry a version before its digest: `repo:@sha256:…` is not a usable reference. */
function assertVersioned(image: InstanceImage) {
  if (!image.tag || image.tag.startsWith("@"))
    throw new Error(
      `Instance image ${image.repository} has no version in its tag "${image.tag}"`,
    );
}

const envName = (state: VetraCloudEnvironmentState) =>
  `"${state.genericSubdomain ?? state.label ?? "unnamed"}"`;

/** Environments that are going or gone: nothing to update. */
const GONE = new Set<VetraCloudEnvironmentState["status"]>([
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

type FusionEnvEntry = { name: string; value: string | null; isSecret: boolean };

/** What an instance's environment document carries of its settings (secret values never). */
export interface InstanceSettingsEnv {
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secretNames: string[];
}

export const envSettings = (s: InstanceSettings): InstanceSettingsEnv => ({
  revision: s.revision,
  plain: s.plain,
  secretNames: s.secrets.map((x) => x.name),
});

/**
 * The FUSION env of an instance (spec section 5 + 14.2). Plain entries render
 * inline; secret entries are names the processor turns into secretEnv refs to
 * <tenant>-secrets, whose values the reconciler delivered (settings/deliver.ts).
 * Order is fixed: sameEnv compares it.
 */
export function fusionEnv(
  image: InstanceImage,
  admins: string,
  settings: InstanceSettingsEnv,
): FusionEnvEntry[] {
  return [
    { name: "PH_HOST", value: image.phHost, isSecret: false },
    { name: "ADMINS", value: admins, isSecret: false },
    ...settings.plain.map((p) => ({
      name: p.name,
      value: p.value,
      isSecret: false,
    })),
    { name: SETTINGS_REVISION_ENV, value: settings.revision, isSecret: false },
    ...[...VETRA_GENERATED_SECRETS, ...settings.secretNames].map((name) => ({
      name,
      value: null,
      isSecret: true,
    })),
  ];
}

/** Created by this slice or later: its database never saw a self-generated master key. */
export const declaresVetraSecrets = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? []).some(
    (e) => e.name === WORKFLOWS_MASTER_KEY && e.isSecret === true,
  );

/** Secret names the environment declares (Vetra's and the publisher's). */
export const declaredSecretNames = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? [])
    .filter((e) => e.isSecret === true)
    .map((e) => e.name);

/** The settings revision the environment asks for (what its pods should run). */
export const settingsRevisionOf = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? []).find(
    (e) => e.name === SETTINGS_REVISION_ENV && !e.isSecret,
  )?.value ?? null;

export interface CreateInstanceInput {
  label: string;
  /** The DNS label (genericSubdomain); the host image is served at its apex. */
  host: string;
  baseDomain: string;
  registry: string;
  owner: string;
  ownerOrgId: string | null;
  appId: string;
  gitRef: string;
  /** The PR of a preview instance; null (or absent) for a branch instance. */
  prNumber?: number | null;
  imageProject: string;
  image: InstanceImage;
  admins: string;
  settings: InstanceSettingsEnv;
  /** Set the FUSION version (the host starts). False: the reconciler starts it once the tenant's secrets are in place. */
  start: boolean;
}

/**
 * A new instance environment. Linked as the App's PREVIEW: the processor
 * renders it as a cheap dev environment (size S, one Postgres without S3
 * backups, no kept /data; overview gaps 5 and 6). APPROVE is sent separately.
 */
export function instanceCreateActions(i: CreateInstanceInput): Action[] {
  assertVersioned(i.image);
  return [
    setLabel({ label: i.label }),
    initialize({
      genericSubdomain: i.host,
      genericBaseDomain: i.baseDomain,
      defaultPackageRegistry: i.registry,
    }),
    setOwner({ address: i.owner }),
    ...(i.ownerOrgId
      ? [setOwnerOrg({ ownerOrgId: i.ownerOrgId, operators: [] })]
      : []),
    setAppLink({
      appId: i.appId,
      role: "PREVIEW",
      prNumber: i.prNumber ?? null,
      gitRef: i.gitRef,
      imageProject: i.imageProject,
    }),
    enableService({ type: "FUSION", prefix: "fusion" }),
    setApexService({ type: "FUSION" }),
    setFusionConfig({
      image: i.image.repository,
      env: fusionEnv(i.image, i.admins, i.settings),
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
    ...(i.start
      ? [setServiceVersion({ type: "FUSION", version: i.image.tag })]
      : []),
  ];
}

const sameEnv = (state: VetraCloudEnvironmentState, want: FusionEnvEntry[]) =>
  JSON.stringify(
    (state.fusion?.env ?? []).map((e) => ({
      name: e.name,
      value: e.value ?? null,
      isSecret: e.isSecret ?? false,
    })),
  ) === JSON.stringify(want);

/**
 * The actions that bring an existing instance environment to `image`; [] when it already
 * runs it or is going away. Throws on anything that is not an instance (a licensed
 * environment, or one that is not an app PREVIEW): these actions are system-signed, so
 * the reducer's template lock does not stop them, and this is the guard.
 */
export function instanceUpdateActions(
  state: VetraCloudEnvironmentState,
  image: InstanceImage,
  admins: string,
  settings: InstanceSettingsEnv,
  start = true,
): Action[] {
  if (state.managedBy)
    throw new Error(
      `Environment ${envName(state)} is licensed (managedBy set): not an instance`,
    );
  if (state.app?.role !== "PREVIEW")
    throw new Error(
      `Environment ${envName(state)} is not an instance (not an app PREVIEW)`,
    );
  if (GONE.has(state.status)) return [];
  assertVersioned(image);
  const fusion = state.services.find((s) => s.type === "FUSION");
  const env = fusionEnv(image, admins, settings);
  const changes: Action[] = [];
  if (!fusion?.enabled)
    changes.push(enableService({ type: "FUSION", prefix: "fusion" }));
  if (
    state.fusion?.image !== image.repository ||
    state.fusion?.autoUpdate ||
    !sameEnv(state, env)
  ) {
    changes.push(
      setFusionConfig({
        image: image.repository,
        env,
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
    );
  }
  // Not started yet (no version) and not allowed to start: env and image only.
  if (fusion?.version !== image.tag && (start || !!fusion?.version))
    changes.push(setServiceVersion({ type: "FUSION", version: image.tag }));
  if (changes.length === 0) return [];
  // STOPPED ignores changes (no CHANGES_PENDING): wake first.
  return state.status === "STOPPED"
    ? [wakeEnvironment({}), ...changes]
    : changes;
}
