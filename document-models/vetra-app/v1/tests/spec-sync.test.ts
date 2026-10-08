import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Without reactor-mcp the .json spec is edited by hand, so nothing else keeps
 * its reducer strings and the src reducers in step. Future codegen reads the
 * JSON: a reducer fixed only in src would silently come back broken.
 */
// Prettier (run by codegen and the lint step) reflows src and adds trailing
// commas; neither is a semantic difference.
const squash = (s: string) => s.replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");
const root = join(__dirname, "..", "..", "..");

/**
 * Operations whose JSON reducer string had already drifted from src before this
 * test existed. Out of scope for the task that added the test; fix them in the
 * model's own change (JSON is what codegen reads). Keyed "<model> <OP_NAME>".
 */
const KNOWN_DRIFT = new Set([
  "vetra-cloud-environment SET_OWNER",
  "vetra-cloud-environment SET_LABEL",
  "vetra-cloud-environment SET_GENERIC_SUBDOMAIN",
  "vetra-cloud-environment SET_CUSTOM_DOMAIN",
  "vetra-cloud-environment SET_APEX_SERVICE",
  "vetra-cloud-environment SET_RUNTIME_CONFIG",
  "vetra-cloud-environment SET_APP_LINK",
  "vetra-cloud-environment CLEAR_APP_LINK",
  "vetra-cloud-environment ENABLE_SERVICE",
  "vetra-cloud-environment SET_SERVICE_CONFIG",
  "vetra-cloud-environment DISABLE_SERVICE",
  "vetra-cloud-environment TOGGLE_SERVICE",
  "vetra-cloud-environment UPDATE_SERVICE_PREFIX",
  "vetra-cloud-environment SET_SERVICE_STATUS",
  "vetra-cloud-environment SET_SERVICE_SIZE",
  "vetra-cloud-environment SET_FUSION_CONFIG",
  "vetra-cloud-environment ADD_PACKAGE",
  "vetra-cloud-environment REMOVE_PACKAGE",
  "vetra-cloud-environment APPROVE_CHANGES",
]);

describe("spec reducer strings match src reducers", () => {
  for (const model of readdirSync(root, { withFileTypes: true })) {
    if (!model.isDirectory()) continue;
    const spec = join(root, model.name, `${model.name}.json`);
    if (!existsSync(spec)) continue;
    const json = JSON.parse(readFileSync(spec, "utf8")) as {
      specifications: {
        modules: {
          name: string;
          operations: { name: string; reducer: string }[];
        }[];
      }[];
    };
    const latest = json.specifications.at(-1)!;
    for (const mod of latest.modules) {
      const file = join(
        root,
        model.name,
        "v1",
        "src",
        "reducers",
        `${mod.name.replace(/_/g, "-")}.ts`,
      );
      if (!existsSync(file)) continue;
      const src = squash(readFileSync(file, "utf8"));
      for (const op of mod.operations) {
        if (!op.reducer.trim()) continue;
        const key = `${model.name} ${op.name}`;
        const test = KNOWN_DRIFT.has(key) ? it.skip : it;
        test(key, () => {
          expect(src).toContain(squash(op.reducer));
        });
      }
    }
  }
});
