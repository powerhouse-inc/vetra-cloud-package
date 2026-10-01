import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FUSION_TAG_PATTERN,
  harborArtifactsUrl,
  pickNewestTag,
  runFusionAutoUpdateOnce,
  type FusionEnvRow,
  type HarborArtifact,
} from "../fusion-auto-update.js";

const art = (push_time: string, ...tags: string[]): HarborArtifact => ({
  push_time,
  tags: tags.length ? tags.map((name) => ({ name })) : null,
});

const env = (over: Partial<FusionEnvRow> = {}): FusionEnvRow => ({
  id: "doc-1",
  name: "achra",
  tenantId: "vast-vole-351c8164-8tgxdfjj",
  status: "READY",
  services: JSON.stringify([
    { type: "FUSION", enabled: true, version: "sha-aaaaaaaaaaaa" },
  ]),
  fusion: JSON.stringify({
    image: "cr.vetra.io/achra/frontend",
    env: [],
    autoUpdate: true,
    autoUpdateTagPattern: null,
  }),
  ...over,
});

describe("pickNewestTag", () => {
  const re = new RegExp(DEFAULT_FUSION_TAG_PATTERN);

  it("picks the newest matching tag by push time", () => {
    expect(
      pickNewestTag(
        [
          art("2026-10-01T10:00:00Z", "sha-111111111111"),
          art("2026-10-01T12:00:00Z", "sha-222222222222", "latest"),
          art("2026-10-01T11:00:00Z", "sha-333333333333"),
        ],
        re,
      ),
    ).toBe("sha-222222222222");
  });

  it("ignores non-matching and untagged artifacts", () => {
    expect(
      pickNewestTag(
        [art("2026-10-01T12:00:00Z", "latest"), art("2026-10-01T13:00:00Z")],
        re,
      ),
    ).toBeNull();
  });
});

describe("harborArtifactsUrl", () => {
  it("double-encodes nested repository paths for the Harbor v2 API", () => {
    expect(harborArtifactsUrl("cr.vetra.io/achra/web/frontend")).toBe(
      "https://cr.vetra.io/api/v2.0/projects/achra/repositories/web%252Ffrontend/artifacts?sort=-push_time&page_size=20&with_tag=true",
    );
  });
});

describe("runFusionAutoUpdateOnce", () => {
  const newest = [art("2026-10-01T12:00:00Z", "sha-bbbbbbbbbbbb")];

  it("bumps an env whose newest matching tag differs", async () => {
    const bump = vi.fn(async () => true);
    const bumped = await runFusionAutoUpdateOnce({
      listEnvs: async () => [env()],
      listArtifacts: async () => newest,
      bump,
    });
    expect(bump).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-1" }), "sha-bbbbbbbbbbbb");
    expect(bumped).toEqual(["doc-1"]);
  });

  it("does nothing when already on the newest tag", async () => {
    const bump = vi.fn(async () => true);
    await runFusionAutoUpdateOnce({
      listEnvs: async () => [
        env({ services: JSON.stringify([{ type: "FUSION", enabled: true, version: "sha-bbbbbbbbbbbb" }]) }),
      ],
      listArtifacts: async () => newest,
      bump,
    });
    expect(bump).not.toHaveBeenCalled();
  });

  it("skips envs with auto-update off, FUSION disabled, no image, or a sleeping/terminated status", async () => {
    const bump = vi.fn(async () => true);
    const list = vi.fn(async () => newest);
    await runFusionAutoUpdateOnce({
      listEnvs: async () => [
        env({ id: "off", fusion: JSON.stringify({ image: "cr.vetra.io/a/b", env: [], autoUpdate: false, autoUpdateTagPattern: null }) }),
        env({ id: "disabled", services: JSON.stringify([{ type: "FUSION", enabled: false, version: null }]) }),
        env({ id: "noimage", fusion: JSON.stringify({ image: null, env: [], autoUpdate: true, autoUpdateTagPattern: null }) }),
        env({ id: "stopped", status: "STOPPED" }),
        env({ id: "gone", status: "DESTROYED" }),
        env({ id: "draft", status: "DRAFT" }),
        env({ id: "pending", status: "CHANGES_PENDING" }),
        env({ id: "deploying", status: "DEPLOYING" }),
        env({ id: "nofusion", fusion: null }),
      ],
      listArtifacts: list,
      bump,
    });
    expect(bump).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("honours a custom tag pattern", async () => {
    const bump = vi.fn(async () => true);
    await runFusionAutoUpdateOnce({
      listEnvs: async () => [
        env({ fusion: JSON.stringify({ image: "cr.vetra.io/achra/frontend", env: [], autoUpdate: true, autoUpdateTagPattern: "^v\\d+\\.\\d+\\.\\d+$" }) }),
      ],
      listArtifacts: async () => [
        art("2026-10-01T13:00:00Z", "sha-cccccccccccc"),
        art("2026-10-01T12:00:00Z", "v1.2.3"),
      ],
      bump,
    });
    expect(bump).toHaveBeenCalledWith(expect.anything(), "v1.2.3");
  });

  it("keeps going when one env's Harbor lookup fails", async () => {
    const bump = vi.fn(async () => true);
    const bumped = await runFusionAutoUpdateOnce({
      listEnvs: async () => [env({ id: "broken" }), env({ id: "ok" })],
      listArtifacts: vi
        .fn()
        .mockRejectedValueOnce(new Error("harbor 500"))
        .mockResolvedValueOnce(newest),
      bump,
    });
    expect(bumped).toEqual(["ok"]);
  });

  it("retries an env whose last deploy failed", async () => {
    const bump = vi.fn(async () => true);
    await runFusionAutoUpdateOnce({
      listEnvs: async () => [env({ status: "DEPLOYMENt_FAILED" })],
      listArtifacts: async () => newest,
      bump,
    });
    expect(bump).toHaveBeenCalled();
  });
});
