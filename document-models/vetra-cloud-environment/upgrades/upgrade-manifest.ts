import type { UpgradeManifest } from "document-model";
import { latestVersion, supportedVersions } from "./versions.js";

export const vetraCloudEnvironmentUpgradeManifest: UpgradeManifest<
  typeof supportedVersions
> = {
  documentType: "powerhouse/vetra-cloud-environment",
  latestVersion,
  supportedVersions,
  upgrades: {},
};
