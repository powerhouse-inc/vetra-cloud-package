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

/** The settings Vetra sets on every instance in this slice (spec section 5; slice 4 adds the rest). */
export function fusionEnv(
  image: InstanceImage,
  admins: string,
): FusionEnvEntry[] {
  return [
    { name: "PH_HOST", value: image.phHost, isSecret: false },
    { name: "ADMINS", value: admins, isSecret: false },
  ];
}

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
  imageProject: string;
  image: InstanceImage;
  admins: string;
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
      prNumber: null,
      gitRef: i.gitRef,
      imageProject: i.imageProject,
    }),
    enableService({ type: "FUSION", prefix: "fusion" }),
    setApexService({ type: "FUSION" }),
    setFusionConfig({
      image: i.image.repository,
      env: fusionEnv(i.image, i.admins),
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
    setServiceVersion({ type: "FUSION", version: i.image.tag }),
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
  const env = fusionEnv(image, admins);
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
  if (fusion?.version !== image.tag)
    changes.push(setServiceVersion({ type: "FUSION", version: image.tag }));
  if (changes.length === 0) return [];
  // STOPPED ignores changes (no CHANGES_PENDING): wake first.
  return state.status === "STOPPED"
    ? [wakeEnvironment({}), ...changes]
    : changes;
}
