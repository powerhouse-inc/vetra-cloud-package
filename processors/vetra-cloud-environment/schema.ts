export interface Environments {
  id: string;
  name: string | null;
  subdomain: string | null;
  tenantId: string | null;
  customDomain: string | null;
  packages: string | null;
  services: string | null;
  status: string | null;
}

export interface DB {
  environments: Environments;
}
