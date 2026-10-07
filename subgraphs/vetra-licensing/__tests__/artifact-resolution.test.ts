import { describe, expect, it } from "vitest";
import {
  resolveTemplateArtifacts,
  repositoryOf,
  templateNeedsArtifacts,
  UnresolvableArtifactError,
} from "../artifact-resolution.js";
import {
  MultipleFusionServicesError,
  renderCreateActions,
  renderUpdateActions,
  templateHash,
  UnresolvedFusionServiceError,
  validateTemplate,
  type TemplateShape,
} from "../template.js";
import type { AppArtifact } from "../reads.js";

const base: TemplateShape = {
  services: [],
  packages: [],
  size: null,
  baseDomain: "vetra.io",
  packageRegistry: null,
};

const withImage = (over: Record<string, unknown> = {}): TemplateShape => ({
  ...base,
  services: [
    {
      id: "s1",
      type: "FUSION",
      prefix: "psb",
      artifactName: "dtbau-psb",
      artifactChannel: "LATEST",
      ...over,
    },
  ],
});

const ref = (name: string, v: string) => `cr.vetra.io/app-dtbau/${name}:${v}`;

const catalogue = (
  versions: string[],
  channels: { channel: string; version: string }[],
): AppArtifact[] => [
  {
    kind: "FUSION_IMAGE",
    name: "dtbau-psb",
    versions: versions.map((v) => ({
      version: v,
      reference: ref("dtbau-psb", v),
    })),
    channels,
  },
];

describe("resolveTemplateArtifacts", () => {
  it("fills in the version the channel points at", () => {
    const out = resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.0.0", "1.1.0"], [{ channel: "LATEST", version: "1.1.0" }]),
    );
    expect(out.services[0]).toMatchObject({
      artifactName: "dtbau-psb",
      resolvedVersion: "1.1.0",
    });
  });

  it("leaves a service with no artifact untouched", () => {
    const t: TemplateShape = {
      ...base,
      services: [{ id: "s1", type: "SWITCHBOARD", prefix: "api" }],
    };
    expect(resolveTemplateArtifacts(t, [])).toStrictEqual(t);
  });

  it("defaults to LATEST when the template names no channel", () => {
    const out = resolveTemplateArtifacts(
      withImage({ artifactChannel: null }),
      catalogue(["2.0.0"], [{ channel: "LATEST", version: "2.0.0" }]),
    );
    expect(out.services[0]!.resolvedVersion).toBe("2.0.0");
  });

  it("refuses an image the app has never published", () => {
    expect(() => resolveTemplateArtifacts(withImage(), [])).toThrow(
      UnresolvableArtifactError,
    );
  });

  it("refuses a channel that has no build yet", () => {
    expect(() =>
      resolveTemplateArtifacts(
        withImage({ artifactChannel: "STAGING" }),
        catalogue(["1.0.0"], [{ channel: "LATEST", version: "1.0.0" }]),
      ),
    ).toThrow(/no STAGING build yet/);
  });

  // The yanked-version case: running last week's image because this week's was
  // withdrawn is worse than holding the licence until it is resolvable.
  it("refuses a channel pointing at a version that is no longer published", () => {
    expect(() =>
      resolveTemplateArtifacts(
        withImage(),
        catalogue(["1.1.0"], [{ channel: "LATEST", version: "1.0.0" }]),
      ),
    ).toThrow(/no longer published/);
  });

  it("knows which templates need resolving", () => {
    expect(templateNeedsArtifacts(withImage())).toBe(true);
    expect(templateNeedsArtifacts(base)).toBe(false);
  });
});

describe("hashing the resolved set", () => {
  // THE point of resolution. The template text is identical before and after a
  // publish, so a hash taken over it would never move and no holder would ever
  // be re-provisioned onto the new image.
  it("changes when the channel moves to a new version", () => {
    const before = resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.0.0"], [{ channel: "LATEST", version: "1.0.0" }]),
    );
    const after = resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.0.0", "1.1.0"], [{ channel: "LATEST", version: "1.1.0" }]),
    );

    expect(templateHash(before)).not.toBe(templateHash(after));
    // and the unresolved template really is identical, which is why this matters
    expect(JSON.stringify(withImage())).toBe(JSON.stringify(withImage()));
  });

  it("is stable when nothing has moved", () => {
    const resolve = () =>
      resolveTemplateArtifacts(
        withImage(),
        catalogue(["1.0.0"], [{ channel: "LATEST", version: "1.0.0" }]),
      );
    expect(templateHash(resolve())).toBe(templateHash(resolve()));
  });

  it("separates two tiers that differ only by image", () => {
    const a = withImage();
    const b = withImage({ artifactName: "dtbau-backup" });
    const arts: AppArtifact[] = [
      {
        kind: "FUSION_IMAGE",
        name: "dtbau-psb",
        versions: [{ version: "1.0.0", reference: ref("dtbau-psb", "1.0.0") }],
        channels: [{ channel: "LATEST", version: "1.0.0" }],
      },
      {
        kind: "FUSION_IMAGE",
        name: "dtbau-backup",
        versions: [
          { version: "1.0.0", reference: ref("dtbau-backup", "1.0.0") },
        ],
        channels: [{ channel: "LATEST", version: "1.0.0" }],
      },
    ];
    expect(templateHash(resolveTemplateArtifacts(a, arts))).not.toBe(
      templateHash(resolveTemplateArtifacts(b, arts)),
    );
  });
});

describe("repositoryOf", () => {
  // SET_FUSION_CONFIG refuses a tag or digest: the service's version picks the tag.
  it("strips a tag", () => {
    expect(repositoryOf("cr.vetra.io/app-dtbau/psb:1.2.3")).toBe(
      "cr.vetra.io/app-dtbau/psb",
    );
  });

  it("strips a digest", () => {
    expect(repositoryOf("cr.vetra.io/app-dtbau/psb@sha256:abc")).toBe(
      "cr.vetra.io/app-dtbau/psb",
    );
  });

  it("leaves a bare repository alone", () => {
    expect(repositoryOf("cr.vetra.io/app-dtbau/psb")).toBe(
      "cr.vetra.io/app-dtbau/psb",
    );
  });

  // A registry host may carry a port; that colon is not a tag separator.
  it("does not mistake a registry port for a tag", () => {
    expect(repositoryOf("localhost:5000/app/psb")).toBe(
      "localhost:5000/app/psb",
    );
    expect(repositoryOf("localhost:5000/app/psb:2.0.0")).toBe(
      "localhost:5000/app/psb",
    );
  });

  it("fills the repository in during resolution", () => {
    const out = resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.1.0"], [{ channel: "LATEST", version: "1.1.0" }]),
    );
    expect(out.services[0]).toMatchObject({
      resolvedVersion: "1.1.0",
      resolvedRepository: "cr.vetra.io/app-dtbau/dtbau-psb",
    });
  });
});

describe("rendering a resolved FUSION service", () => {
  const resolved = () =>
    resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.1.0"], [{ channel: "LATEST", version: "1.1.0" }]),
    );

  it("enables the service, pins the repository and sets the tag", () => {
    const actions = renderCreateActions({
      label: "Vault",
      subdomain: "abc",
      owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      template: resolved(),
    });
    const byType = (t: string) => actions.find((a) => a.type === t);

    expect(byType("ENABLE_SERVICE")?.input).toMatchObject({
      type: "FUSION",
      prefix: "psb",
    });
    // SET_FUSION_CONFIG refuses a tag: the service version supplies it.
    expect(byType("SET_FUSION_CONFIG")?.input).toMatchObject({
      image: "cr.vetra.io/app-dtbau/dtbau-psb",
      autoUpdate: false,
    });
    expect(byType("SET_SERVICE_VERSION")?.input).toMatchObject({
      type: "FUSION",
      version: "1.1.0",
    });
  });

  // Resolution happens before rendering. Rendering an unresolved FUSION service
  // would deploy an environment with no image at all.
  it("refuses to render a FUSION service that was never resolved", () => {
    expect(() =>
      renderCreateActions({
        label: "Vault",
        subdomain: "abc",
        owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        template: withImage(),
      }),
    ).toThrow(UnresolvedFusionServiceError);
  });

  // An environment stores ONE fusion config, so two images cannot both run.
  it("refuses a template carrying two FUSION services", () => {
    const two: TemplateShape = {
      ...base,
      services: [
        {
          id: "s1",
          type: "FUSION",
          prefix: "a",
          resolvedRepository: "cr.vetra.io/p/a",
          resolvedVersion: "1",
        },
        {
          id: "s2",
          type: "FUSION",
          prefix: "b",
          resolvedRepository: "cr.vetra.io/p/b",
          resolvedVersion: "1",
        },
      ],
    };
    expect(() => validateTemplate(two)).toThrow(MultipleFusionServicesError);
  });

  it("does not restate an image the environment already runs", () => {
    const t = resolved();
    const actions = renderUpdateActions({
      label: "Vault",
      template: t,
      current: {
        services: [
          {
            type: "FUSION",
            prefix: "psb",
            enabled: true,
            status: "ACTIVE",
            version: "1.1.0",
            url: null,
            config: null,
            selectedRessource: null,
          },
        ],
        packages: [],
        fusion: {
          image: "cr.vetra.io/app-dtbau/dtbau-psb",
          env: [],
          autoUpdate: false,
          autoUpdateTagPattern: null,
        },
      } as never,
    });
    expect(actions.map((a) => a.type)).not.toContain("SET_FUSION_CONFIG");
  });

  it("restates the image when the resolved version moved", () => {
    const t = resolveTemplateArtifacts(
      withImage(),
      catalogue(["1.1.0", "2.0.0"], [{ channel: "LATEST", version: "2.0.0" }]),
    );
    const actions = renderUpdateActions({
      label: "Vault",
      template: t,
      current: {
        services: [
          {
            type: "FUSION",
            prefix: "psb",
            enabled: true,
            status: "ACTIVE",
            version: "1.1.0",
            url: null,
            config: null,
            selectedRessource: null,
          },
        ],
        packages: [],
        fusion: {
          image: "cr.vetra.io/app-dtbau/dtbau-psb",
          env: [],
          autoUpdate: false,
          autoUpdateTagPattern: null,
        },
      } as never,
    });
    expect(
      actions.find((a) => a.type === "SET_SERVICE_VERSION")?.input,
    ).toMatchObject({
      version: "2.0.0",
    });
  });
});
