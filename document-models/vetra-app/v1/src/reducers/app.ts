import type { VetraAppAppOperations } from "document-models/vetra-app/v1";

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
};
