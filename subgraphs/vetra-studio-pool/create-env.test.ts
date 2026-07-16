import { describe, it, expect, vi } from "vitest";
import { createStudioEnvironmentDoc } from "./create-env.js";

describe("createStudioEnvironmentDoc", () => {
  it("creates a doc, derives subdomain/tenantId, applies the studio batch (no SET_OWNER)", async () => {
    const execute = vi.fn<
      (docId: string, branch: string, actions: unknown[]) => Promise<void>
    >(async () => {});
    const reactor = {
      createDocument: vi.fn(async () => "aaaabbbb-1111-2222-3333-444455556666"),
      execute,
    };

    const res = await createStudioEnvironmentDoc(reactor, {
      version: "0.0.1-dev.19",
      sizeName: "VETRA_AGENT_XXL",
      registry: "https://registry.dev.vetra.io",
      switchboardUrl: "https://switchboard.vetra.io",
    });

    expect(reactor.createDocument).toHaveBeenCalledOnce();
    // tenantId derives from the same document id fragment as the subdomain helper.
    expect(res.documentId).toBe("aaaabbbb-1111-2222-3333-444455556666");
    expect(res.subdomain).toMatch(/^[a-z]+-[a-z]+-aaaabbbb$/);
    expect(res.tenantId).toBe(`${res.subdomain}-aaaabbbb`);

    // One batched execute on the "main" branch.
    expect(execute).toHaveBeenCalledOnce();
    const [docId, branch, actions] = execute.mock.calls[0];
    expect(docId).toBe(res.documentId);
    expect(branch).toBe("main");
    expect((actions as { type: string }[]).map((a) => a.type)).toEqual([
      "SET_LABEL",
      "INITIALIZE",
      "ADD_PACKAGE",
      "ENABLE_SERVICE",
      "APPROVE_CHANGES",
    ]);
    // No ownership action — env stays owner-null until claimed.
    expect((actions as { type: string }[]).some((a) => a.type === "SET_OWNER")).toBe(false);
    // The studio installs the renamed `vetra` CLI package.
    const addPkg = (
      actions as { type: string; input: { packageName?: string } }[]
    ).find((a) => a.type === "ADD_PACKAGE");
    expect(addPkg?.input.packageName).toBe("vetra");
    // INITIALIZE carries the derived subdomain.
    const init = (actions as { type: string; input: { genericSubdomain: string } }[]).find(
      (a) => a.type === "INITIALIZE",
    );
    expect(init?.input.genericSubdomain).toBe(res.subdomain);

    // ENABLE_SERVICE injects VETRA_REQUIRE_API_KEY so the key-less warm pod
    // refuses agent work until a claim provides a credential.
    const svc = (
      actions as { type: string; input: { clintConfig?: { env?: { name: string; value: string }[] } } }[]
    ).find((a) => a.type === "ENABLE_SERVICE");
    expect(svc?.input.clintConfig?.env).toContainEqual({
      name: "VETRA_REQUIRE_API_KEY",
      value: "true",
      isSecret: false,
    });
    // The configured switchboard is stamped so the agent creates environments
    // against it (not vetra-cli's staging default).
    expect(svc?.input.clintConfig?.env).toContainEqual({
      name: "VETRA_CLOUD_SWITCHBOARD_URL",
      value: "https://switchboard.vetra.io",
      isSecret: false,
    });
    // The product PUBLISH target is stamped from cfg.registry so the agent
    // doesn't fall to vetra-cli's registry.dev.vetra.io default.
    expect(svc?.input.clintConfig?.env).toContainEqual({
      name: "PH_REGISTRY_URL",
      value: "https://registry.dev.vetra.io",
      isSecret: false,
    });
  });
});
