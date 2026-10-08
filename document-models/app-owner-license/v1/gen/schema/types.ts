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

export type ActivateLicenseInput = {
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type AppOwnerLicenseState = {
  app: Maybe<Scalars["PHID"]["output"]>;
  details: Maybe<Scalars["String"]["output"]>;
  end: Maybe<Scalars["DateTime"]["output"]>;
  issued: Maybe<Scalars["DateTime"]["output"]>;
  issuer: Maybe<LicenseIssuerKind>;
  kind: Maybe<Scalars["String"]["output"]>;
  replacedBy: Maybe<Scalars["PHID"]["output"]>;
  revokedReason: Maybe<Scalars["String"]["output"]>;
  stage: Maybe<Scalars["PHID"]["output"]>;
  start: Maybe<Scalars["DateTime"]["output"]>;
  status: LicenseStatus;
  user: Maybe<Scalars["String"]["output"]>;
};

export type ExpireLicenseInput = {
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type IssueLicenseInput = {
  app: Scalars["PHID"]["input"];
  details?: InputMaybe<Scalars["String"]["input"]>;
  end?: InputMaybe<Scalars["DateTime"]["input"]>;
  issued: Scalars["DateTime"]["input"];
  issuedBy?: InputMaybe<Scalars["String"]["input"]>;
  issuer: LicenseIssuerKind;
  kind?: InputMaybe<Scalars["String"]["input"]>;
  licenseType?: InputMaybe<Scalars["PHID"]["input"]>;
  stage?: InputMaybe<Scalars["PHID"]["input"]>;
  start: Scalars["DateTime"]["input"];
  user: Scalars["String"]["input"];
};

export type LicenseIssuerKind =
  | "ACHRA_SUBSCRIPTION"
  | "INVITE_CODE"
  | "PUBLISHER_GRANT";

export type LicenseStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "ISSUED"
  | "REPLACED"
  | "REVOKED";

export type MigrateLicenseInput = {
  details?: InputMaybe<Scalars["String"]["input"]>;
  kind: Scalars["String"]["input"];
  user: Scalars["String"]["input"];
};

export type ReplaceLicenseInput = {
  replacedBy: Scalars["PHID"]["input"];
};

export type RevokeLicenseInput = {
  reason?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetStageInput = {
  stage?: InputMaybe<Scalars["PHID"]["input"]>;
};
