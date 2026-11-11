import { insertRelease, type ReleaseRow } from "../releases/repo.js";
import { getApp } from "../repo.js";
import type { Harness } from "./harness.js";

export const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A recorded build or release of the app, as ciReportRelease stores it. */
export async function seedRelease(
  h: Harness,
  appId: string,
  over: {
    version: string;
    run: number;
    branch?: string | null;
    pr?: number | null;
    kind?: "build" | "release";
    digest?: string;
  },
): Promise<ReleaseRow> {
  const app = (await getApp(h.db, appId))!;
  const { row } = await insertRelease(h.db, {
    app_id: appId,
    version: over.version,
    kind: over.kind ?? "build",
    branch: over.pr != null ? null : (over.branch ?? "main"),
    pr: over.pr ?? null,
    run: over.run,
    commit: "abcdef1234567",
    notes: null,
    customer_notes: null,
    image_ref: `cr.vetra.io/acme/${app.slug}:${over.version}`,
    image_digest: over.digest ?? digest("a"),
    host: "cli",
    packages: "[]",
    requires: "{}",
    migrates: false,
    powerhouse_version: "6.2.3",
    base_image: "node:24@sha256:00",
    created_at: "2026-11-11T00:00:00.000Z",
  });
  return row;
}
