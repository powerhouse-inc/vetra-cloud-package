import type { StudioPowerStatus } from "../subgraphs/vetra-housekeeping/policy.js";

export type PowerState = {
  host: string;
  envId: string | null;
  subdomain: string | null;
  owner: string | null;
  status: StudioPowerStatus;
};

const POWER_FIELDS = "host envId subdomain owner status";

export interface SwitchboardClient {
  powerState(host: string): Promise<PowerState>;
  sleepStudio(host: string): Promise<PowerState>;
  wakeStudio(host: string): Promise<PowerState>;
}

/**
 * Thin client for the vetra-housekeeping subgraph. The service authenticates as
 * an admin (the mutations are admin-gated); the bearer token is injected by the
 * activator/detector, never exposed to end users.
 */
export function createSwitchboardClient(opts: {
  url: string;
  adminToken: string;
  fetchTimeoutMs?: number;
}): SwitchboardClient {
  const timeout = opts.fetchTimeoutMs ?? 15_000;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(opts.url, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.adminToken}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: any; errors?: Array<{ message: string }> };
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
      return body.data as T;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async powerState(host) {
      const d = await gql<{ VetraHousekeeping: { studioPowerState: PowerState } }>(
        `query($host:String!){ VetraHousekeeping { studioPowerState(host:$host){ ${POWER_FIELDS} } } }`,
        { host },
      );
      return d.VetraHousekeeping.studioPowerState;
    },
    async sleepStudio(host) {
      const d = await gql<{ VetraHousekeeping: { sleepStudio: PowerState } }>(
        `mutation($host:String!){ VetraHousekeeping { sleepStudio(host:$host){ ${POWER_FIELDS} } } }`,
        { host },
      );
      return d.VetraHousekeeping.sleepStudio;
    },
    async wakeStudio(host) {
      const d = await gql<{ VetraHousekeeping: { wakeStudio: PowerState } }>(
        `mutation($host:String!){ VetraHousekeeping { wakeStudio(host:$host){ ${POWER_FIELDS} } } }`,
        { host },
      );
      return d.VetraHousekeeping.wakeStudio;
    },
  };
}
