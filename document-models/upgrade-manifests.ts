import type { UpgradeManifest } from "document-model";
import { vetraCloudEnvironmentUpgradeManifest } from "./vetra-cloud-environment/upgrades/upgrade-manifest.js";

export const upgradeManifests: UpgradeManifest<readonly number[]>[] = [
  vetraCloudEnvironmentUpgradeManifest,
];
