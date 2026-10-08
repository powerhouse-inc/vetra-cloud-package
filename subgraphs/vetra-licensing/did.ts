export class UnsupportedDidError extends Error {
  override name = "UnsupportedDidError";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PKH = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;

/**
 * Every licence, grant, allow-list entry and redemption keys its holder on one
 * spelling: did:pkh:eip155:1:<lowercased address>. Renown issues bearers on
 * several chains for the same wallet; a holder is a wallet, not a chain, so
 * the chain is normalised away. Anything that is not an EVM wallet is refused:
 * an environment owner must be an address.
 */
export function normaliseUserDid(input: string): string {
  const s = input.trim();
  if (ADDRESS.test(s)) return didForAddress(s);
  const m = PKH.exec(s);
  if (m) return didForAddress(m[2]);
  throw new UnsupportedDidError(
    `${input} is not a did:pkh:eip155 DID or a 0x address`,
  );
}

export function didForAddress(address: string): string {
  return `did:pkh:eip155:1:${address.toLowerCase()}`;
}

export function addressOfDid(did: string): string {
  return normaliseUserDid(did).slice("did:pkh:eip155:1:".length);
}

/** The authenticated caller's DID, or null when the request carries no user. */
export function callerDid(ctx: { user?: { address?: string } }): string | null {
  const address = ctx.user?.address;
  return address ? didForAddress(address) : null;
}
