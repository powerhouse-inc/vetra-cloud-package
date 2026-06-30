import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  "Coarse power state of a studio, derived from its environment document status."
  enum StudioPowerStatus {
    AWAKE
    SLEEPING
    WAKING
    UNKNOWN
  }

  type StudioPowerState {
    "Studio host queried, e.g. tall-duck-ab12cd34.vetra.io."
    host: String!
    "Environment document id, or null if no studio matches the host."
    envId: String
    subdomain: String
    owner: String
    status: StudioPowerStatus!
  }

  type VetraHousekeepingQueries {
    "Resolve a studio host to its current power state (used by the wake activator)."
    studioPowerState(host: String!): StudioPowerState!
  }

  type VetraHousekeepingMutations {
    "Put a claimed, eligible studio to sleep. Idempotent. Admin only."
    sleepStudio(host: String!): StudioPowerState!
    "Wake a sleeping studio. No-op if already awake/waking. Idempotent. Admin only."
    wakeStudio(host: String!): StudioPowerState!
  }

  type Query {
    VetraHousekeeping: VetraHousekeepingQueries
  }

  type Mutation {
    VetraHousekeeping: VetraHousekeepingMutations!
  }
`;
