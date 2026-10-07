import { useCallback, useState } from "react";
import {
  useSelectedAppLicenseTypeDocument,
  actions,
} from "document-models/app-license-type/v1";
import type { TemplateServiceType } from "document-models/app-license-type/v1";
import { DocumentToolbar } from "@powerhousedao/design-system/connect";
import { SectionCard } from "../vetra-cloud-environment/components/SectionCard.js";
import { vetraThemeCSS } from "../vetra-cloud-environment/components/vetra-theme.js";
import { StatusBadge } from "./components/StatusBadge.js";

/**
 * A publisher defines their own tiers here: what an environment looks like for
 * a holder of this licence type, and how long a grant of it lasts.
 *
 * The subgraph refuses a CLINT service in this slice (it needs a clintConfig
 * the template cannot express yet), so the option is offered but warned about
 * rather than hidden -- a publisher who picks it would otherwise only find out
 * when provisioning silently failed for every holder.
 */
const SERVICE_TYPES: TemplateServiceType[] = [
  "CONNECT",
  "SWITCHBOARD",
  "CLINT",
];
const UNSUPPORTED_SERVICE_TYPES = new Set<string>(["CLINT"]);

const RESOURCE_SIZES = [
  "VETRA_AGENT_S",
  "VETRA_AGENT_M",
  "VETRA_AGENT_L",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
];

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--v-border)",
  background: "var(--v-bg)",
  color: "var(--v-fg)",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--v-muted-fg)",
  marginBottom: 5,
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--v-primary)",
  color: "var(--v-primary-fg)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: "1 1 180px", minWidth: 0 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export default function Editor() {
  const [document, dispatch] = useSelectedAppLicenseTypeDocument();
  const state = document.state.global;
  const template = state.template;
  const isRetired = state.status === "RETIRED";

  const [app, setApp] = useState(state.app ?? "");
  const [kind, setKind] = useState(state.kind ?? "");
  const [label, setLabel] = useState(state.label ?? "");
  const [validityDays, setValidityDays] = useState(
    state.validityDays === null ? "" : String(state.validityDays),
  );

  const [size, setSize] = useState(template?.size ?? "");
  const [baseDomain, setBaseDomain] = useState(template?.baseDomain ?? "");
  const [packageRegistry, setPackageRegistry] = useState(
    template?.packageRegistry ?? "",
  );

  const [svcType, setSvcType] = useState<TemplateServiceType>("CONNECT");
  const [svcPrefix, setSvcPrefix] = useState("");
  const [pkgName, setPkgName] = useState("");
  const [pkgVersion, setPkgVersion] = useState("");

  const handleSaveDetails = useCallback(() => {
    const days = validityDays.trim() === "" ? null : Number(validityDays);
    if (days !== null && (!Number.isInteger(days) || days <= 0)) return;
    dispatch(
      actions.setLicenseTypeDetails({
        app: app.trim() || null,
        kind: kind.trim() || null,
        label: label.trim() || null,
        validityDays: days,
      }),
    );
  }, [dispatch, app, kind, label, validityDays]);

  const handleSaveTemplate = useCallback(() => {
    dispatch(
      actions.setTemplate({
        size: size.trim() || null,
        baseDomain: baseDomain.trim() || null,
        packageRegistry: packageRegistry.trim() || null,
      }),
    );
  }, [dispatch, size, baseDomain, packageRegistry]);

  const handleAddService = useCallback(() => {
    dispatch(
      actions.addTemplateService({
        id: crypto.randomUUID(),
        type: svcType,
        prefix: svcPrefix.trim() || null,
      }),
    );
    setSvcPrefix("");
  }, [dispatch, svcType, svcPrefix]);

  const handleAddPackage = useCallback(() => {
    if (!pkgName.trim()) return;
    dispatch(
      actions.addTemplatePackage({
        id: crypto.randomUUID(),
        packageName: pkgName.trim(),
        version: pkgVersion.trim() || null,
      }),
    );
    setPkgName("");
    setPkgVersion("");
  }, [dispatch, pkgName, pkgVersion]);

  // Mirrors publishLicenseTypeOperation exactly, so the button is only live
  // when the reducer would actually accept it.
  const canPublish =
    !!state.kind && !!template && (template.services.length ?? 0) > 0;

  return (
    <div className="vetra-editor" style={{ background: "var(--v-bg)" }}>
      <style>{vetraThemeCSS}</style>
      <DocumentToolbar />

      <div
        style={{
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 20,
          color: "var(--v-fg)",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 14 }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            {state.label || state.kind || "Untitled licence type"}
          </h2>
          <StatusBadge status={state.status} />
        </div>

        {isRetired && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "var(--v-muted)",
              fontSize: 13,
            }}
          >
            This licence type is retired. Existing licences keep running, but it
            can no longer provision new environments.
          </div>
        )}

        <SectionCard title="Details">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <Field label="App (PHID)">
              <input
                style={inputStyle}
                value={app}
                onChange={(e) => setApp(e.target.value)}
                placeholder="document id of the app"
              />
            </Field>
            <Field label="Kind">
              <input
                style={inputStyle}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                placeholder="free, pro, …"
              />
            </Field>
            <Field label="Label">
              <input
                style={inputStyle}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Knowledge Vault — Pro"
              />
            </Field>
            <Field label="Validity (days)">
              <input
                style={inputStyle}
                value={validityDays}
                onChange={(e) => setValidityDays(e.target.value)}
                placeholder="blank = open-ended"
                inputMode="numeric"
              />
            </Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <button style={buttonStyle} onClick={handleSaveDetails}>
              Save details
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Template">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <Field label="Size (CLINT only — unused in this slice)">
              <select
                style={inputStyle}
                value={size}
                onChange={(e) => setSize(e.target.value)}
              >
                <option value="">none</option>
                {RESOURCE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Base domain">
              <input
                style={inputStyle}
                value={baseDomain}
                onChange={(e) => setBaseDomain(e.target.value)}
                placeholder="vetra.io"
              />
            </Field>
            <Field label="Package registry">
              <input
                style={inputStyle}
                value={packageRegistry}
                onChange={(e) => setPackageRegistry(e.target.value)}
                placeholder="https://registry.vetra.io"
              />
            </Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <button style={buttonStyle} onClick={handleSaveTemplate}>
              Save template
            </button>
          </div>
        </SectionCard>

        <SectionCard title={`Services (${template?.services.length ?? 0})`}>
          {template?.services.length ? (
            <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13 }}>
              {template.services.map((s) => (
                <li key={s.id} style={{ marginBottom: 4 }}>
                  <strong>{s.type}</strong>
                  {s.prefix ? ` — ${s.prefix}` : ""}
                  {UNSUPPORTED_SERVICE_TYPES.has(s.type) && (
                    <span style={{ color: "var(--v-destructive)" }}>
                      {" "}
                      — not provisionable yet
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p
              style={{
                fontSize: 13,
                color: "var(--v-muted-fg)",
                marginTop: 0,
              }}
            >
              At least one service is required before this type can be
              published.
            </p>
          )}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end" }}
          >
            <Field label="Type">
              <select
                style={inputStyle}
                value={svcType}
                onChange={(e) =>
                  setSvcType(e.target.value as TemplateServiceType)
                }
              >
                {SERVICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {UNSUPPORTED_SERVICE_TYPES.has(t)
                      ? " (not provisionable yet)"
                      : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prefix">
              <input
                style={inputStyle}
                value={svcPrefix}
                onChange={(e) => setSvcPrefix(e.target.value)}
                placeholder="defaults to the lowercased type"
              />
            </Field>
            <button style={buttonStyle} onClick={handleAddService}>
              Add service
            </button>
          </div>
          {UNSUPPORTED_SERVICE_TYPES.has(svcType) && (
            <p
              style={{
                fontSize: 12,
                color: "var(--v-destructive)",
                marginBottom: 0,
              }}
            >
              A CLINT service needs a configuration the template cannot express
              yet, so provisioning will refuse this template.
            </p>
          )}
        </SectionCard>

        <SectionCard title={`Packages (${template?.packages.length ?? 0})`}>
          {template?.packages.length ? (
            <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13 }}>
              {template.packages.map((p) => (
                <li key={p.id} style={{ marginBottom: 4 }}>
                  {p.packageName}
                  <span style={{ color: "var(--v-muted-fg)" }}>
                    @{p.version || "latest"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p
              style={{
                fontSize: 13,
                color: "var(--v-muted-fg)",
                marginTop: 0,
              }}
            >
              No packages. The environment will come up empty.
            </p>
          )}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end" }}
          >
            <Field label="Package name">
              <input
                style={inputStyle}
                value={pkgName}
                onChange={(e) => setPkgName(e.target.value)}
                placeholder="@powerhousedao/knowledge-note"
              />
            </Field>
            <Field label="Version">
              <input
                style={inputStyle}
                value={pkgVersion}
                onChange={(e) => setPkgVersion(e.target.value)}
                placeholder="latest"
              />
            </Field>
            <button style={buttonStyle} onClick={handleAddPackage}>
              Add package
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Lifecycle">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              style={{
                ...buttonStyle,
                opacity: canPublish ? 1 : 0.5,
                cursor: canPublish ? "pointer" : "not-allowed",
              }}
              disabled={!canPublish}
              onClick={() => dispatch(actions.publishLicenseType({}))}
            >
              Publish
            </button>
            <button
              style={{
                ...buttonStyle,
                background: "var(--v-destructive)",
                opacity: state.status === "ACTIVE" ? 1 : 0.5,
                cursor: state.status === "ACTIVE" ? "pointer" : "not-allowed",
              }}
              disabled={state.status !== "ACTIVE"}
              onClick={() => dispatch(actions.retireLicenseType({}))}
            >
              Retire
            </button>
            {!canPublish && (
              <span style={{ fontSize: 12, color: "var(--v-muted-fg)" }}>
                Needs a kind and at least one service.
              </span>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
