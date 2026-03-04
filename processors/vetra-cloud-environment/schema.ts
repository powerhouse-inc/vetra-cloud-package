export interface Environments {
  domain: string | null;
  id: string;
  name: string | null;
  packages: string | null;
  services: string | null;
  status: string | null;
}

export interface DB {
  environments: Environments;
}
