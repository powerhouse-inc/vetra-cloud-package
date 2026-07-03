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

  "Loki-derived activity verdict for a studio host over the idle window."
  enum HostActivity {
    "Had real (non-automation) requests in the window."
    ACTIVE
    "Access logs exist but only automation (pings) — the sleep signal."
    IDLE
    "No access logs at all / query failed — cannot measure (never slept)."
    UNKNOWN
  }

  "What the idle detector sees for one claimed READY studio (read-only)."
  type StudioActivity {
    host: String!
    subdomain: String
    envId: String!
    owner: String
    "Environment-document status (these are all claimed + READY)."
    status: String!
    "Passes the sleep policy (claimed, not allowlisted)."
    eligible: Boolean!
    activity: HostActivity!
    "eligible AND activity == IDLE — i.e. the detector would sleep it this pass."
    wouldSleep: Boolean!
  }

  type VetraHousekeepingQueries {
    "Resolve a studio host to its current power state (used by the wake activator)."
    studioPowerState(host: String!): StudioPowerState!
    "Ops view of the idle detector: classify every claimed READY studio (ACTIVE/IDLE/UNKNOWN) without sleeping. Admin only."
    studioActivity: [StudioActivity!]!
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
