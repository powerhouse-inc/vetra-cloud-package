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

export type AddTemplateInput = {
  id: Scalars["OID"]["input"];
  mode: TemplateInstanceMode;
  name?: InputMaybe<Scalars["String"]["input"]>;
};

export type AddTemplatePackageInput = {
  id: Scalars["OID"]["input"];
  packageName: Scalars["String"]["input"];
  templateId: Scalars["OID"]["input"];
  version?: InputMaybe<Scalars["String"]["input"]>;
};

export type AddTemplateServiceInput = {
  artifactChannel?: InputMaybe<AutoUpdateChannel>;
  artifactName?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["OID"]["input"];
  prefix?: InputMaybe<Scalars["String"]["input"]>;
  templateId: Scalars["OID"]["input"];
  type: TemplateServiceType;
};

export type AddTermInput = {
  id: Scalars["OID"]["input"];
  issuers?: InputMaybe<Array<LicenseIssuerKind>>;
  kind: Scalars["String"]["input"];
  label?: InputMaybe<Scalars["String"]["input"]>;
  templateId?: InputMaybe<Scalars["OID"]["input"]>;
  validityDays?: InputMaybe<Scalars["Int"]["input"]>;
};

export type AutoUpdateChannel = "DEV" | "LATEST" | "STAGING";

export type ConnectRepositoryInput = {
  fullName?: InputMaybe<Scalars["String"]["input"]>;
  productionBranch?: InputMaybe<Scalars["String"]["input"]>;
  repositoryId?: InputMaybe<Scalars["String"]["input"]>;
};

export type DeleteTemplateInput = {
  id: Scalars["OID"]["input"];
};

export type LicenseIssuerKind =
  | "ACHRA_SUBSCRIPTION"
  | "INVITE_CODE"
  | "PUBLISHER_GRANT";

export type LicenseTermStatus = "ACTIVE" | "DRAFT" | "RETIRED";

export type PublishTermInput = {
  id: Scalars["OID"]["input"];
};

export type RecordArtifactVersionInput = {
  commitSha?: InputMaybe<Scalars["String"]["input"]>;
  kind: VetraAppArtifactKind;
  name: Scalars["String"]["input"];
  publishedAt: Scalars["DateTime"]["input"];
  reference: Scalars["String"]["input"];
  runId?: InputMaybe<Scalars["String"]["input"]>;
  version: Scalars["String"]["input"];
};

export type RemoveTemplatePackageInput = {
  id: Scalars["OID"]["input"];
  templateId: Scalars["OID"]["input"];
};

export type RemoveTemplateServiceInput = {
  id: Scalars["OID"]["input"];
  templateId: Scalars["OID"]["input"];
};

export type RetireTermInput = {
  id: Scalars["OID"]["input"];
};

export type SetAppDetailsInput = {
  name?: InputMaybe<Scalars["String"]["input"]>;
  owner?: InputMaybe<Scalars["EthereumAddress"]["input"]>;
  slug?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetArtifactChannelInput = {
  channel: AutoUpdateChannel;
  kind: VetraAppArtifactKind;
  name: Scalars["String"]["input"];
  version: Scalars["String"]["input"];
};

export type SetIdentityInput = {
  did?: InputMaybe<Scalars["String"]["input"]>;
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
};

export type SetPreviewsInput = {
  enabled: Scalars["Boolean"]["input"];
  limit: Scalars["Int"]["input"];
  ttlDays: Scalars["Int"]["input"];
};

export type SetProductionEnvironmentInput = {
  environmentId?: InputMaybe<Scalars["OID"]["input"]>;
};

export type SetStatusInput = {
  status: VetraAppStatus;
};

export type SetTemplateDetailsInput = {
  baseDomain?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["OID"]["input"];
  mode?: InputMaybe<TemplateInstanceMode>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  packageRegistry?: InputMaybe<Scalars["URL"]["input"]>;
  sharedEnvironment?: InputMaybe<Scalars["PHID"]["input"]>;
  size?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetTermDetailsInput = {
  id: Scalars["OID"]["input"];
  issuers?: InputMaybe<Array<LicenseIssuerKind>>;
  kind?: InputMaybe<Scalars["String"]["input"]>;
  label?: InputMaybe<Scalars["String"]["input"]>;
  templateId?: InputMaybe<Scalars["OID"]["input"]>;
  validityDays?: InputMaybe<Scalars["Int"]["input"]>;
};

export type TemplateInstanceMode = "DEDICATED" | "SHARED";

export type TemplatePackage = {
  id: Scalars["OID"]["output"];
  packageName: Maybe<Scalars["String"]["output"]>;
  version: Maybe<Scalars["String"]["output"]>;
};

export type TemplateService = {
  artifactChannel: Maybe<AutoUpdateChannel>;
  artifactName: Maybe<Scalars["String"]["output"]>;
  id: Scalars["OID"]["output"];
  prefix: Maybe<Scalars["String"]["output"]>;
  type: TemplateServiceType;
};

export type TemplateServiceType =
  | "CLINT"
  | "CONNECT"
  | "DOCLING"
  | "FUSION"
  | "PAPERLESS"
  | "SPECKLE"
  | "SWITCHBOARD";

export type VetraAppArtifact = {
  channels: Array<VetraAppArtifactChannel>;
  id: Scalars["OID"]["output"];
  kind: VetraAppArtifactKind;
  name: Scalars["String"]["output"];
  versions: Array<VetraAppArtifactVersion>;
};

export type VetraAppArtifactChannel = {
  channel: AutoUpdateChannel;
  version: Scalars["String"]["output"];
};

export type VetraAppArtifactKind = "FUSION_IMAGE" | "PACKAGE";

export type VetraAppArtifactVersion = {
  commitSha: Maybe<Scalars["String"]["output"]>;
  publishedAt: Scalars["DateTime"]["output"];
  reference: Scalars["String"]["output"];
  runId: Maybe<Scalars["String"]["output"]>;
  version: Scalars["String"]["output"];
};

export type VetraAppEnvironmentTemplate = {
  baseDomain: Maybe<Scalars["String"]["output"]>;
  id: Scalars["OID"]["output"];
  mode: TemplateInstanceMode;
  name: Maybe<Scalars["String"]["output"]>;
  packageRegistry: Maybe<Scalars["URL"]["output"]>;
  packages: Array<TemplatePackage>;
  services: Array<TemplateService>;
  sharedEnvironment: Maybe<Scalars["PHID"]["output"]>;
  size: Maybe<Scalars["String"]["output"]>;
};

export type VetraAppIdentity = {
  did: Maybe<Scalars["String"]["output"]>;
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type VetraAppLicenseTerm = {
  id: Scalars["OID"]["output"];
  issuers: Array<LicenseIssuerKind>;
  kind: Scalars["String"]["output"];
  label: Maybe<Scalars["String"]["output"]>;
  status: LicenseTermStatus;
  templateId: Maybe<Scalars["OID"]["output"]>;
  validityDays: Maybe<Scalars["Int"]["output"]>;
};

export type VetraAppPreviews = {
  enabled: Scalars["Boolean"]["output"];
  limit: Scalars["Int"]["output"];
  ttlDays: Scalars["Int"]["output"];
};

export type VetraAppRepository = {
  fullName: Maybe<Scalars["String"]["output"]>;
  productionBranch: Maybe<Scalars["String"]["output"]>;
  repositoryId: Maybe<Scalars["String"]["output"]>;
};

export type VetraAppState = {
  artifacts: Array<VetraAppArtifact>;
  identity: Maybe<VetraAppIdentity>;
  name: Maybe<Scalars["String"]["output"]>;
  owner: Maybe<Scalars["EthereumAddress"]["output"]>;
  previews: Maybe<VetraAppPreviews>;
  productionEnvironmentId: Maybe<Scalars["OID"]["output"]>;
  repository: Maybe<VetraAppRepository>;
  slug: Maybe<Scalars["String"]["output"]>;
  status: VetraAppStatus;
  templates: Array<VetraAppEnvironmentTemplate>;
  terms: Array<VetraAppLicenseTerm>;
};

export type VetraAppStatus =
  | "ACTIVE"
  | "DELETED"
  | "DISCONNECTED"
  | "PENDING_IDENTITY";
