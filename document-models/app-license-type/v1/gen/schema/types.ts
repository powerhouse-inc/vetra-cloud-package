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

export type AddTemplatePackageInput = {
  id: Scalars["OID"]["input"];
  packageName?: InputMaybe<Scalars["String"]["input"]>;
  version?: InputMaybe<Scalars["String"]["input"]>;
};

export type AddTemplateServiceInput = {
  id: Scalars["OID"]["input"];
  prefix?: InputMaybe<Scalars["String"]["input"]>;
  type: TemplateServiceType;
};

export type AppLicenseTypeState = {
  app: Maybe<Scalars["PHID"]["output"]>;
  kind: Maybe<Scalars["String"]["output"]>;
  label: Maybe<Scalars["String"]["output"]>;
  status: LicenseTypeStatus;
  template: Maybe<EnvironmentTemplate>;
  validityDays: Maybe<Scalars["Int"]["output"]>;
};

export type EnvironmentTemplate = {
  baseDomain: Maybe<Scalars["String"]["output"]>;
  packageRegistry: Maybe<Scalars["URL"]["output"]>;
  packages: Array<TemplatePackage>;
  services: Array<TemplateService>;
  size: Maybe<Scalars["String"]["output"]>;
};

export type LicenseTypeStatus = "ACTIVE" | "DRAFT" | "RETIRED";

export type PublishLicenseTypeInput = {
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type RetireLicenseTypeInput = {
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type SetLicenseTypeDetailsInput = {
  app?: InputMaybe<Scalars["PHID"]["input"]>;
  kind?: InputMaybe<Scalars["String"]["input"]>;
  label?: InputMaybe<Scalars["String"]["input"]>;
  validityDays?: InputMaybe<Scalars["Int"]["input"]>;
};

export type SetTemplateInput = {
  baseDomain?: InputMaybe<Scalars["String"]["input"]>;
  packageRegistry?: InputMaybe<Scalars["URL"]["input"]>;
  size?: InputMaybe<Scalars["String"]["input"]>;
};

export type TemplatePackage = {
  id: Scalars["OID"]["output"];
  packageName: Maybe<Scalars["String"]["output"]>;
  version: Maybe<Scalars["String"]["output"]>;
};

export type TemplateService = {
  id: Scalars["OID"]["output"];
  prefix: Maybe<Scalars["String"]["output"]>;
  type: TemplateServiceType;
};

export type TemplateServiceType = "CLINT" | "CONNECT" | "SWITCHBOARD";
