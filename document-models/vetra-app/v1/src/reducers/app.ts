import type { VetraAppAppOperations } from "document-models/vetra-app/v1";
import {
  UnknownArtifactError,
  UnknownArtifactVersionError,
} from "../../gen/app/error.js";

export const vetraAppAppOperations: VetraAppAppOperations = {
  setAppDetailsOperation(state, action) {
    if (action.input.name) state.name = action.input.name;
    if (action.input.slug) state.slug = action.input.slug;
    if (action.input.owner) state.owner = action.input.owner;
  },
  connectRepositoryOperation(state, action) {
    state.repository = {
      repositoryId: action.input.repositoryId ?? null,
      fullName: action.input.fullName ?? null,
      productionBranch: action.input.productionBranch ?? null,
    };
  },
  setIdentityOperation(state, action) {
    state.identity = {
      did: action.input.did ?? null,
      expiresAt: action.input.expiresAt ?? null,
    };
  },
  setStatusOperation(state, action) {
    state.status = action.input.status;
  },
  setPreviewsOperation(state, action) {
    state.previews = {
      enabled: action.input.enabled,
      limit: action.input.limit,
      ttlDays: action.input.ttlDays,
    };
  },
  setProductionEnvironmentOperation(state, action) {
    state.productionEnvironmentId = action.input.environmentId ?? null;
  },
  recordArtifactVersionOperation(state, action) {
    const MAX_ARTIFACT_VERSIONS = 50;

    let artifact = state.artifacts.find(
      (a) => a.kind === action.input.kind && a.name === action.input.name,
    );
    if (!artifact) {
      artifact = {
        id: `${action.input.kind}:${action.input.name}`,
        kind: action.input.kind,
        name: action.input.name,
        versions: [],
        channels: [],
      };
      state.artifacts.push(artifact);
    }

    const entry = {
      version: action.input.version,
      reference: action.input.reference,
      commitSha: action.input.commitSha ?? null,
      runId: action.input.runId ?? null,
      publishedAt: action.input.publishedAt,
    };
    const at = artifact.versions.findIndex(
      (v) => v.version === action.input.version,
    );
    if (at >= 0) {
      artifact.versions[at] = entry;
    } else {
      artifact.versions.push(entry);
    }

    // A document that grows without bound eventually fails to load, and a dropdown
    // never needs the whole history.
    if (artifact.versions.length > MAX_ARTIFACT_VERSIONS) {
      artifact.versions = artifact.versions.slice(
        artifact.versions.length - MAX_ARTIFACT_VERSIONS,
      );
    }
    // A channel aimed at a version the cap dropped is worse than no channel.
    artifact.channels = artifact.channels.filter((c) =>
      artifact.versions.some((v) => v.version === c.version),
    );
  },
  setArtifactChannelOperation(state, action) {
    const artifact = state.artifacts.find(
      (a) => a.kind === action.input.kind && a.name === action.input.name,
    );
    if (!artifact) {
      throw new UnknownArtifactError(
        `${action.input.kind} ${action.input.name} has published nothing`,
      );
    }
    if (!artifact.versions.some((v) => v.version === action.input.version)) {
      throw new UnknownArtifactVersionError(
        `${action.input.name} has no published version ${action.input.version}`,
      );
    }
    const at = artifact.channels.findIndex(
      (c) => c.channel === action.input.channel,
    );
    const entry = {
      channel: action.input.channel,
      version: action.input.version,
    };
    if (at >= 0) {
      artifact.channels[at] = entry;
    } else {
      artifact.channels.push(entry);
    }
  },
};
