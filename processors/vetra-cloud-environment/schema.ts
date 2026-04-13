export interface Environments {
  id: string;
  name: string | null;
  subdomain: string | null;
  tenantId: string | null;
  customDomain: string | null;
  packages: string | null;
  services: string | null;
  status: string | null;
  deployingSince: string | null;
  /** EthereumAddress (lowercased) of the user who first signed an action on this document. */
  createdBy: string | null;
}

export interface DB {
  environments: Environments;
}
