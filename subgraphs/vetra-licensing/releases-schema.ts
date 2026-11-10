import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * App release rollout (spec 2026-11-10 §4.5). Its own root, vetraReleases,
 * so the vetraPublisher and vetraSubscriptions contracts stay exactly as
 * written. App fields authorise the app's owner on every call, as
 * vetraPublisher does; environment fields take the environment's holder or
 * the owner of its app. Enum-valued fields travel as String.
 */
export const releasesSchema: DocumentNode = gql`
  type AppReleaseSettings {
    appId: String!
    "AUTO | GATED"
    policy: String!
    defaultNoticeHours: Int!
  }

  type AppReleaseCanary {
    environmentId: String!
    "The FUSION version it runs; null before it has one."
    version: String
    "The environment status (READY when healthy); null when its document is gone."
    status: String
  }

  "One FUSION image: what STAGING and LATEST point at, and what each canary runs."
  type AppReleaseCandidate {
    artifactName: String!
    staging: String
    latest: String
    canaries: [AppReleaseCanary!]!
  }

  type AppRolloutStatusCount {
    "PENDING | APPLYING | SUCCEEDED | REVERTED | RESTORED | FAILED | SUPERSEDED"
    status: String!
    count: Int!
  }

  type AppRollout {
    id: String!
    artifactName: String!
    version: String!
    "ACTIVE | PAUSED | SUPERSEDED | COMPLETE"
    status: String!
    applyAfter: String!
    "The promoter's DID (lower-cased)."
    promotedBy: String!
    promotedAt: String!
    pausedAt: String
    "Names the environment whose update failed, and why."
    pausedReason: String
    counts: [AppRolloutStatusCount!]!
  }

  type EnvironmentUpdateRecord {
    id: String!
    fromVersion: String!
    toVersion: String!
    "PENDING | APPLYING | SUCCEEDED | REVERTED | RESTORED | FAILED | SUPERSEDED"
    status: String!
    dueAt: String!
    requestedAt: String
    startedAt: String
    finishedAt: String
    "Why it failed, or why it needs attention while PENDING."
    error: String
    createdAt: String!
  }

  type OpenEnvironmentUpdate {
    toVersion: String!
    dueAt: String!
    "PENDING | APPLYING"
    status: String!
    canUpdateNow: Boolean!
  }

  type HolderEnvironmentUpdate {
    "The update waiting or applying; null when the environment is current."
    open: OpenEnvironmentUpdate
    "The last 20 updates, newest first."
    history: [EnvironmentUpdateRecord!]!
  }

  type PublisherEnvironmentUpdate {
    status: String!
    toVersion: String!
    dueAt: String!
    error: String
  }

  extend type PublisherEnvironment {
    "The FUSION version the environment runs."
    runningVersion: String
    "Follows STAGING and takes releases first."
    isCanary: Boolean!
    "The newest update that was not superseded."
    update: PublisherEnvironmentUpdate
  }

  type VetraReleasesQueries {
    releaseSettings(appId: String!): AppReleaseSettings!
    releaseCandidates(appId: String!): [AppReleaseCandidate!]!
    rollouts(appId: String!): [AppRollout!]!
    "The environment's holder, or the owner of its app."
    environmentUpdate(environmentId: String!): HolderEnvironmentUpdate!
  }

  type VetraReleasesMutations {
    "defaultNoticeHours absent: unchanged. GATED requires a canary."
    setReleasePolicy(
      appId: String!
      policy: String!
      defaultNoticeHours: Int
    ): AppReleaseSettings!
    "Only an environment you hold yourself can be a canary."
    setCanaryEnvironment(
      appId: String!
      environmentId: String!
      canary: Boolean!
    ): Boolean!
    "noticeHours absent: the app's default; 0 for an urgent fix."
    promoteRelease(
      appId: String!
      artifactName: String!
      version: String!
      noticeHours: Int
    ): AppRollout!
    resumeRollout(appId: String!, rolloutId: String!): Boolean!
    forceEnvironmentUpdate(appId: String!, environmentId: String!): Boolean!
    "The environment's holder, or the owner of its app."
    updateEnvironmentNow(environmentId: String!): Boolean!
  }

  extend type Query {
    vetraReleases: VetraReleasesQueries!
  }

  extend type Mutation {
    vetraReleases: VetraReleasesMutations!
  }
`;
