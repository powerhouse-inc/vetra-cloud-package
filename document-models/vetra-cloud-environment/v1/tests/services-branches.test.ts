import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  enableService,
  disableService,
  toggleService,
  updateServicePrefix,
  setServiceStatus,
  setServiceVersion,
  setServiceConfig,
  setServiceSize,
  setFusionConfig,
  setDnsRecords,
  setCustomDomain,
  setRuntimeConfig,
  addPackage,
  removePackage,
  setPackageVersion,
} from "document-models/vetra-cloud-environment/v1";

const ALICE = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

const lastError = (doc: { operations: Record<string, { error?: string }[]> }) =>
  doc.operations.global?.at(-1)?.error;

const pkg = {
  registry: "https://r",
  name: "p",
};

describe("services scenario: CLINT lifecycle and error branches", () => {
  it("requires clintConfig for CLINT", () => {
    const doc = reducer(
      utils.createDocument(),
      enableService({ type: "CLINT", prefix: "a" }),
    );
    expect(lastError(doc)).toMatch(/clintConfig is required/);
    expect(doc.state.global.services).toHaveLength(0);
  });

  it("rejects a prefix used by another service type", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "shared" }),
    );
    doc = reducer(doc, enableService({ type: "SWITCHBOARD", prefix: "shared" }));
    expect(lastError(doc)).toMatch(/already used/);
    expect(doc.state.global.services).toHaveLength(1);
  });

  it("normalizes CLINT config, re-enables by prefix and updates it", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({
        type: "CLINT",
        prefix: "agent",
        selectedRessource: "VETRA_AGENT_M",
        clintConfig: {
          package: { ...pkg, version: "1.0.0" },
          env: [
            { name: "PLAIN", value: "v", isSecret: false },
            { name: "SECRET", value: "hidden", isSecret: true },
            { name: "BARE" },
          ],
          serviceCommand: "run",
          selectedRessource: "VETRA_AGENT_M",
        },
      }),
    );
    expect(lastError(doc)).toBeUndefined();
    let svc = doc.state.global.services[0];
    expect(svc.selectedRessource).toBe("VETRA_AGENT_M");
    expect(svc.config).toStrictEqual({
      package: { ...pkg, version: "1.0.0" },
      env: [
        { name: "PLAIN", value: "v", isSecret: false },
        { name: "SECRET", value: null, isSecret: true },
        { name: "BARE", value: null, isSecret: null },
      ],
      serviceCommand: "run",
      selectedRessource: "VETRA_AGENT_M",
    });

    // Re-enable same CLINT prefix: updates config and size, keeps one entry.
    doc = reducer(doc, disableService({ type: "CLINT", prefix: "agent" }));
    expect(doc.state.global.services[0].enabled).toBe(false);
    doc = reducer(
      doc,
      enableService({
        type: "CLINT",
        prefix: "agent",
        selectedRessource: "VETRA_AGENT_L",
        clintConfig: { package: pkg, env: [] },
      }),
    );
    expect(doc.state.global.services).toHaveLength(1);
    svc = doc.state.global.services[0];
    expect(svc.enabled).toBe(true);
    expect(svc.selectedRessource).toBe("VETRA_AGENT_L");
    expect(svc.config?.package.version).toBeNull();
    expect(svc.config?.serviceCommand).toBeNull();

    // Re-enable without config / size leaves them untouched.
    doc = reducer(doc, enableService({ type: "CLINT", prefix: "agent", clintConfig: { package: pkg, env: [] } }));
    expect(doc.state.global.services[0].selectedRessource).toBe("VETRA_AGENT_L");
  });

  it("re-enabling a singleton with a new prefix updates the existing entry", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "c1" }),
    );
    doc = reducer(doc, enableService({ type: "CONNECT", prefix: "c2" }));
    expect(doc.state.global.services).toHaveLength(1);
    expect(doc.state.global.services[0].prefix).toBe("c2");
    expect(doc.state.global.services[0].config).toBeNull();
  });

  it("disables CLINT by prefix, CLINT without prefix, and ignores unknown", () => {
    const clint = (prefix: string) =>
      enableService({
        type: "CLINT",
        prefix,
        clintConfig: { package: pkg, env: [] },
      });
    let doc = reducer(utils.createDocument(), clint("a"));
    doc = reducer(doc, clint("b"));
    doc = reducer(doc, disableService({ type: "CLINT", prefix: "b" }));
    expect(doc.state.global.services.map((s) => s.enabled)).toStrictEqual([
      true,
      false,
    ]);
    doc = reducer(doc, disableService({ type: "CLINT" }));
    expect(doc.state.global.services[0].enabled).toBe(false);
    doc = reducer(doc, disableService({ type: "FUSION" }));
    expect(lastError(doc)).toBeUndefined();
  });

  it("errors with ServiceNotFound for every lookup-based operation", () => {
    let doc = utils.createDocument();
    doc = reducer(doc, toggleService({ type: "CONNECT" }));
    expect(lastError(doc)).toMatch(/not found/);
    doc = reducer(doc, updateServicePrefix({ type: "CONNECT", prefix: "x" }));
    expect(lastError(doc)).toMatch(/not found/);
    doc = reducer(
      doc,
      setServiceStatus({ type: "CLINT", prefix: "x", status: "ACTIVE" }),
    );
    expect(lastError(doc)).toMatch(/not found/);
    doc = reducer(doc, setServiceVersion({ type: "CONNECT", version: "1" }));
    expect(lastError(doc)).toMatch(/not found/);
    doc = reducer(doc, setServiceConfig({ prefix: "x", config: { package: pkg, env: [] } }));
    expect(lastError(doc)).toMatch(/No service with prefix/);
    doc = reducer(doc, setServiceSize({ prefix: "x", size: "VETRA_AGENT_M" }));
    expect(lastError(doc)).toMatch(/No service with prefix/);
  });

  it("toggles, re-prefixes, sets status with and without url, and version", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "c" }),
    );
    doc = reducer(doc, toggleService({ type: "CONNECT" }));
    expect(doc.state.global.services[0].enabled).toBe(false);
    doc = reducer(doc, updateServicePrefix({ type: "CONNECT", prefix: "c2" }));
    expect(doc.state.global.services[0].prefix).toBe("c2");
    doc = reducer(doc, setServiceStatus({ type: "CONNECT", status: "ACTIVE", url: "https://c2.x" }));
    expect(doc.state.global.services[0].url).toBe("https://c2.x");
    doc = reducer(doc, setServiceStatus({ type: "CONNECT", status: "ACTIVE" }));
    expect(doc.state.global.services[0].url).toBe("https://c2.x");
    doc = reducer(doc, setServiceVersion({ type: "CONNECT", version: "2" }));
    expect(doc.state.global.services[0].version).toBe("2");
  });

  it("setServiceConfig rejects non-CLINT and applies config to CLINT", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "c" }),
    );
    doc = reducer(doc, setServiceConfig({ prefix: "c", config: { package: pkg, env: [] } }));
    expect(lastError(doc)).toMatch(/only CLINT/);

    doc = reducer(
      doc,
      enableService({ type: "CLINT", prefix: "a", clintConfig: { package: pkg, env: [] } }),
    );
    doc = reducer(
      doc,
      setServiceConfig({
        prefix: "a",
        config: {
          package: { ...pkg, version: "2" },
          env: [
            { name: "S", value: "x", isSecret: true },
            { name: "P", value: "y" },
          ],
          serviceCommand: "go",
          selectedRessource: "VETRA_AGENT_L",
        },
      }),
    );
    const a = doc.state.global.services.find((s) => s.prefix === "a");
    expect(a?.selectedRessource).toBe("VETRA_AGENT_L");
    expect(a?.config?.env).toStrictEqual([
      { name: "S", value: null, isSecret: true },
      { name: "P", value: "y", isSecret: null },
    ]);
    doc = reducer(
      doc,
      setServiceConfig({ prefix: "a", config: { package: pkg, env: [] } }),
    );
    expect(doc.state.global.services[1].selectedRessource).toBe("VETRA_AGENT_L");
    expect(doc.state.global.services[1].config?.selectedRessource).toBeNull();
  });

  it("setServiceSize on non-CLINT leaves config alone", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "c" }),
    );
    doc = reducer(doc, setServiceSize({ prefix: "c", size: "VETRA_AGENT_L" }));
    expect(doc.state.global.services[0].selectedRessource).toBe("VETRA_AGENT_L");
    expect(doc.state.global.services[0].config).toBeNull();
  });
});

describe("setFusionConfig branches", () => {
  const base = { env: [], autoUpdate: false };

  it("accepts null / blank image and pattern and secrets without NEXT_PUBLIC_", () => {
    let doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, image: "  ", autoUpdateTagPattern: "  " }),
    );
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.fusion?.image).toBeNull();
    expect(doc.state.global.fusion?.autoUpdateTagPattern).toBeNull();

    doc = reducer(
      doc,
      setFusionConfig({
        env: [
          { name: "A", value: "1" },
          { name: "NEXT_PUBLIC_OK", value: "1", isSecret: false },
          { name: "SECRET", value: "z", isSecret: true },
        ],
        autoUpdate: true,
        autoUpdateTagPattern: "^sha-.*$",
        image: "cr.vetra.io/p/app",
      }),
    );
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.fusion?.env[0]).toStrictEqual({ name: "A", value: "1", isSecret: null });
    expect(doc.state.global.fusion?.autoUpdateTagPattern).toBe("^sha-.*$");
  });

  it("explains digest and non-registry image errors differently", () => {
    let doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, image: "cr.vetra.io/p/app@sha256:abc" }),
    );
    expect(lastError(doc)).toMatch(/tag or digest/);
    doc = reducer(doc, setFusionConfig({ ...base, image: "nope" }));
    expect(lastError(doc)).toMatch(/must be a repository/);
  });

  it("accepts env with missing value", () => {
    const doc = reducer(
      utils.createDocument(),
      setFusionConfig({ ...base, env: [{ name: "X" }] }),
    );
    expect(doc.state.global.fusion?.env[0].value).toBeNull();
  });
});

describe("owner gate and misc branches", () => {
  it("auto-claims for user-signed actions and rejects other users", () => {
    let doc = reducer(utils.createDocument(), {
      ...enableService({ type: "CONNECT", prefix: "c" }),
      ...userSigner(ALICE),
    });
    expect(doc.state.global.owner).toBe(ALICE.toLowerCase());
    doc = reducer(doc, {
      ...toggleService({ type: "CONNECT" }),
      ...userSigner(BOB),
    });
    expect(lastError(doc)).toMatch(/not the owner/);
    doc = reducer(doc, {
      ...toggleService({ type: "CONNECT" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
  });

  it("handles a signer with no user and a context-less action", () => {
    const action = {
      ...enableService({ type: "CONNECT", prefix: "c" }),
      context: { signer: { app: { name: "s", key: "k" }, signatures: [] } },
    } as unknown as ReturnType<typeof enableService>;
    const doc = reducer(utils.createDocument(), action);
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.owner ?? null).toBeNull();
  });
});

describe("packages and domain misc branches", () => {
  it("covers package registry fallbacks and removal", () => {
    let doc = reducer(
      utils.createDocument(),
      addPackage({ packageName: "a", registry: "https://one" }),
    );
    doc = reducer(doc, addPackage({ packageName: "a", version: "2" }));
    expect(doc.state.global.packages[0]).toStrictEqual({
      registry: "https://one",
      name: "a",
      version: "2",
    });
    doc = reducer(doc, addPackage({ packageName: "a", registry: "https://two" }));
    expect(doc.state.global.packages[0].registry).toBe("https://two");
    doc = reducer(doc, removePackage({ packageName: "" }));
    expect(doc.state.global.packages).toHaveLength(1);
    doc = reducer(doc, removePackage({ packageName: "a" }));
    expect(doc.state.global.packages).toHaveLength(0);
    doc = reducer(doc, setPackageVersion({ packageName: "ghost", version: "1" }));
    expect(lastError(doc)).toBeDefined();
  });

  it("covers dns records and runtime-config issue paths", () => {
    let doc = reducer(
      utils.createDocument(),
      setDnsRecords({ records: [{ type: "A", host: "h", value: "v" }] }),
    );
    expect(doc.state.global.customDomain?.dnsRecords).toHaveLength(1);
    doc = reducer(doc, setRuntimeConfig({ config: JSON.stringify({ bogus: 1 }) }));
    expect(lastError(doc)).toBeDefined();
  });
});

describe("DNS regeneration for a custom domain", () => {
  it("emits A records only for enabled services and skips a disabled domain", () => {
    let doc = reducer(
      utils.createDocument(),
      enableService({ type: "CONNECT", prefix: "c" }),
    );
    doc = reducer(doc, enableService({ type: "SWITCHBOARD", prefix: "s" }));
    doc = reducer(doc, setCustomDomain({ enabled: true, domain: "x.example.com" }));
    expect(doc.state.global.customDomain?.dnsRecords.map((r) => r.host)).toStrictEqual([
      "c.x.example.com",
      "s.x.example.com",
    ]);
    doc = reducer(doc, toggleService({ type: "SWITCHBOARD" }));
    expect(doc.state.global.customDomain?.dnsRecords).toHaveLength(1);
    doc = reducer(doc, setCustomDomain({ enabled: false, domain: "x.example.com" }));
    expect(doc.state.global.customDomain?.dnsRecords).toHaveLength(0);
    doc = reducer(doc, setCustomDomain({ enabled: true }));
    expect(doc.state.global.customDomain?.domain).toBeNull();
  });
});
