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
  AttachmentRef: {
    input: `attachment://v${number}:${string}`;
    output: `attachment://v${number}:${string}`;
  };
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

export type AutoUpdateChannel = "DEV" | "LATEST" | "STAGING";

export type DisableServiceInput = {
  prefix?: InputMaybe<Scalars["String"]["input"]>;
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
  clintConfig?: InputMaybe<VetraCloudServiceClintInput>;
  prefix: Scalars["String"]["input"];
  selectedRessource?: InputMaybe<VetraCloudRessourceSize>;
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

export type SetApexServiceInput = {
  type?: InputMaybe<VetraCloudEnvironmentServiceType>;
};

export type SetAutoUpdateChannelInput = {
  channel?: InputMaybe<AutoUpdateChannel>;
};

export type SetCustomDomainInput = {
  domain?: InputMaybe<Scalars["String"]["input"]>;
  enabled: Scalars["Boolean"]["input"];
};

export type SetDefaultPackageRegistryInput = {
  defaultPackageRegistry: Scalars["URL"]["input"];
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

export type SetOwnerInput = {
  address: Scalars["EthereumAddress"]["input"];
};

export type SetPackageVersionInput = {
  packageName: Scalars["String"]["input"];
  version: Scalars["String"]["input"];
};

export type SetRuntimeConfigInput = {
  config?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetServiceConfigInput = {
  config: VetraCloudServiceClintConfigInput;
  prefix: Scalars["String"]["input"];
};

export type SetServiceSizeInput = {
  prefix: Scalars["String"]["input"];
  size: VetraCloudRessourceSize;
};

export type SetServiceStatusInput = {
  status: ServiceStatus;
  type: VetraCloudEnvironmentServiceType;
  url?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetServiceVersionInput = {
  type: VetraCloudEnvironmentServiceType;
  version: Scalars["String"]["input"];
};

export type SleepEnvironmentInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
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
  config: Maybe<VetraCloudServiceClint>;
  enabled: Scalars["Boolean"]["output"];
  prefix: Scalars["String"]["output"];
  selectedRessource: Maybe<VetraCloudRessourceSize>;
  status: ServiceStatus;
  type: VetraCloudEnvironmentServiceType;
  url: Maybe<Scalars["String"]["output"]>;
  version: Maybe<Scalars["String"]["output"]>;
};

export type VetraCloudEnvironmentServiceType =
  | "CLINT"
  | "CONNECT"
  | "FUSION"
  | "SWITCHBOARD";

export type VetraCloudEnvironmentState = {
  apexService: Maybe<VetraCloudEnvironmentServiceType>;
  autoUpdateChannel: Maybe<AutoUpdateChannel>;
  customDomain: Maybe<VetraCustomDomain>;
  defaultPackageRegistry: Maybe<Scalars["URL"]["output"]>;
  genericBaseDomain: Maybe<Scalars["String"]["output"]>;
  genericSubdomain: Maybe<Scalars["String"]["output"]>;
  label: Maybe<Scalars["String"]["output"]>;
  owner: Maybe<Scalars["EthereumAddress"]["output"]>;
  packages: Array<VetraCloudPackage>;
  runtimeConfig: Maybe<Scalars["String"]["output"]>;
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

export type VetraCloudPackageConfigInput = {
  name: Scalars["String"]["input"];
  registry: Scalars["URL"]["input"];
  version?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCloudPackageInput = {
  name: Scalars["String"]["input"];
  registry: Scalars["URL"]["input"];
  version?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCloudRessourceSize =
  | "VETRA_AGENT_L"
  | "VETRA_AGENT_M"
  | "VETRA_AGENT_S"
  | "VETRA_AGENT_XL"
  | "VETRA_AGENT_XXL";

export type VetraCloudServiceClint = {
  env: Array<VetraCloudServiceEnv>;
  package: VetraCloudPackage;
  selectedRessource: Maybe<VetraCloudRessourceSize>;
  serviceCommand: Maybe<Scalars["String"]["output"]>;
};

export type VetraCloudServiceClintConfigInput = {
  env: Array<VetraCloudServiceEnvConfigInput>;
  package: VetraCloudPackageConfigInput;
  selectedRessource?: InputMaybe<VetraCloudRessourceSize>;
  serviceCommand?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCloudServiceClintInput = {
  env: Array<VetraCloudServiceEnvInput>;
  package: VetraCloudPackageInput;
  selectedRessource?: InputMaybe<VetraCloudRessourceSize>;
  serviceCommand?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCloudServiceEnv = {
  isSecret: Maybe<Scalars["Boolean"]["output"]>;
  name: Scalars["String"]["output"];
  value: Maybe<Scalars["String"]["output"]>;
};

export type VetraCloudServiceEnvConfigInput = {
  isSecret?: InputMaybe<Scalars["Boolean"]["input"]>;
  name: Scalars["String"]["input"];
  value?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCloudServiceEnvInput = {
  isSecret?: InputMaybe<Scalars["Boolean"]["input"]>;
  name: Scalars["String"]["input"];
  value?: InputMaybe<Scalars["String"]["input"]>;
};

export type VetraCustomDomain = {
  dnsRecords: Array<DnsRecord>;
  domain: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
};

export type WakeEnvironmentInput = {
  _placeholder?: InputMaybe<Scalars["String"]["input"]>;
};
