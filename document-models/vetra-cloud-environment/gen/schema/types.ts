export type Maybe<T> = T | null | undefined;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]?: Maybe<T[SubKey]>;
};
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]: Maybe<T[SubKey]>;
};
export type MakeEmpty<
  T extends { [key: string]: unknown },
  K extends keyof T,
> = { [_ in K]?: never };
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  Address: { input: `${string}:0x${string}`; output: `${string}:0x${string}` };
  Amount: {
    input: { unit?: string; value?: number };
    output: { unit?: string; value?: number };
  };
  Amount_Crypto: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Currency: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Fiat: {
    input: { unit: string; value: number };
    output: { unit: string; value: number };
  };
  Amount_Money: { input: number; output: number };
  Amount_Percentage: { input: number; output: number };
  Amount_Tokens: { input: number; output: number };
  Attachment: { input: string; output: string };
  Currency: { input: string; output: string };
  Date: { input: string; output: string };
  DateTime: { input: string; output: string };
  EmailAddress: { input: string; output: string };
  EthereumAddress: { input: string; output: string };
  OID: { input: string; output: string };
  OLabel: { input: string; output: string };
  PHID: { input: string; output: string };
  URL: { input: string; output: string };
  Unknown: { input: unknown; output: unknown };
  Upload: { input: File; output: File };
};

export type AddPackageInput = {
  packageName: Scalars["String"]["input"];
  registry?: InputMaybe<Scalars["URL"]["input"]>;
  version?: InputMaybe<Scalars["String"]["input"]>;
};

export type ApproveChangesInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type ArchiveInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type DisableServiceInput = {
  type: VetraCloudEnvironmentServiceType;
};

export type DnsRecord = {
  host: Scalars["String"]["output"];
  type: Scalars["String"]["output"];
  value: Scalars["String"]["output"];
};

export type DnsRecordInput = {
  host: Scalars["String"]["input"];
  type: Scalars["String"]["input"];
  value: Scalars["String"]["input"];
};

export type EnableServiceInput = {
  prefix: Scalars["String"]["input"];
  type: VetraCloudEnvironmentServiceType;
};

export type InitializeInput = {
  defaultPackageRegistry?: InputMaybe<Scalars["URL"]["input"]>;
  genericBaseDomain: Scalars["String"]["input"];
  genericSubdomain: Scalars["String"]["input"];
};

export type MarkChangesPushedInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type MarkDeploymentStartedInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type MarkDestroyedInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type RemovePackageInput = {
  packageName: Scalars["String"]["input"];
};

export type ReportDeploymentFailedInput = {
  code: Scalars["String"]["input"];
  message: Scalars["String"]["input"];
};

export type ReportDeploymentSucceededInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type ServiceStatus =
  | "ACTIVE"
  | "BILLING_ISSUE"
  | "PROVISIONING"
  | "SUSPENDED";

export type SetCustomDomainInput = {
  domain?: InputMaybe<Scalars["String"]["input"]>;
  enabled: Scalars["Boolean"]["input"];
};

export type SetDnsRecordsInput = {
  records: Array<DnsRecordInput>;
};

export type SetGenericSubdomainInput = {
  genericSubdomain: Scalars["String"]["input"];
};

export type SetLabelInput = {
  label: Scalars["String"]["input"];
};

export type SetServiceStatusInput = {
  status: ServiceStatus;
  type: VetraCloudEnvironmentServiceType;
  url?: InputMaybe<Scalars["String"]["input"]>;
};

export type TerminateEnvironmentInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type ToggleServiceInput = {
  type: VetraCloudEnvironmentServiceType;
};

export type UnarchiveInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};

export type UpdateServicePrefixInput = {
  prefix: Scalars["String"]["input"];
  type: VetraCloudEnvironmentServiceType;
};

export type VetraCloudEnvironmentService = {
  enabled: Scalars["Boolean"]["output"];
  prefix: Scalars["String"]["output"];
  status: ServiceStatus;
  type: VetraCloudEnvironmentServiceType;
  url: Maybe<Scalars["String"]["output"]>;
};

export type VetraCloudEnvironmentServiceType =
  | "CONNECT"
  | "FUSION"
  | "SWITCHBOARD";

export type VetraCloudEnvironmentState = {
  customDomain: Maybe<VetraCustomDomain>;
  defaultPackageRegistry: Maybe<Scalars["URL"]["output"]>;
  genericBaseDomain: Maybe<Scalars["String"]["output"]>;
  genericSubdomain: Maybe<Scalars["String"]["output"]>;
  label: Maybe<Scalars["String"]["output"]>;
  packages: Array<VetraCloudPackage>;
  services: Array<VetraCloudEnvironmentService>;
  status: VetraCloudEnvironmentStatus;
};

export type VetraCloudEnvironmentStatus =
  | "ARCHIVED"
  | "CHANGES_APPROVED"
  | "CHANGES_PENDING"
  | "CHANGES_PUSHED"
  | "DEPLOYING"
  | "DEPLOYMENt_FAILED"
  | "DESTROYED"
  | "DRAFT"
  | "READY"
  | "STOPPED"
  | "TERMINATING";

export type VetraCloudPackage = {
  name: Scalars["String"]["output"];
  registry: Scalars["URL"]["output"];
  version: Maybe<Scalars["String"]["output"]>;
};

export type VetraCustomDomain = {
  dnsRecords: Array<DnsRecord>;
  domain: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
};
