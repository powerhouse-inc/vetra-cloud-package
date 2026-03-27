import { useCallback, useState } from "react";
import {
  useSelectedVetraCloudEnvironmentDocument,
  actions,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import type { VetraCloudEnvironmentStatus } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import { StatusBadge } from "./components/StatusBadge.js";
import { ServicesList } from "./components/ServicesList.js";
import { PackagesList } from "./components/PackagesList.js";
import { SectionCard } from "./components/SectionCard.js";
import { DnsRecordsTable } from "./components/DnsRecordsTable.js";
import { vetraThemeCSS } from "./components/vetra-theme.js";
import { DocumentToolbar } from "@powerhousedao/design-system/connect/components/document-toolbar/document-toolbar";

const READONLY_STATUSES: Set<VetraCloudEnvironmentStatus> = new Set([
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

export default function Editor() {
  const [document, dispatch] = useSelectedVetraCloudEnvironmentDocument();
  const state = document.state.global;
  const isDraft = state.status === "DRAFT";
  const isReadonly = READONLY_STATUSES.has(state.status);

  const [initSubdomain, setInitSubdomain] = useState("");
  const [initBaseDomain, setInitBaseDomain] = useState("");
  const [initRegistry, setInitRegistry] = useState("");

  const handleInitialize = useCallback(() => {
    if (!initSubdomain.trim() || !initBaseDomain.trim()) return;
    dispatch(
      actions.initialize({
        genericSubdomain: initSubdomain.trim(),
        genericBaseDomain: initBaseDomain.trim(),
        defaultPackageRegistry: initRegistry.trim() || undefined,
      }),
    );
  }, [dispatch, initSubdomain, initBaseDomain, initRegistry]);

  const handleSetLabel = useCallback(
    (value: string) => {
      if (value.trim() && value.trim() !== state.label) {
        dispatch(actions.setLabel({ label: value.trim() }));
      }
    },
    [dispatch, state.label],
  );

  const handleSetSubdomain = useCallback(
    (value: string) => {
      if (value.trim() && value.trim() !== state.genericSubdomain) {
        dispatch(
          actions.setGenericSubdomain({ genericSubdomain: value.trim() }),
        );
      }
    },
    [dispatch, state.genericSubdomain],
  );

  const handleToggleCustomDomain = useCallback(
    (enabled: boolean) => {
      dispatch(
        actions.setCustomDomain({
          enabled,
          domain: enabled ? state.customDomain?.domain : undefined,
        }),
      );
    },
    [dispatch, state.customDomain?.domain],
  );

  const handleSetCustomDomainValue = useCallback(
    (domain: string) => {
      dispatch(
        actions.setCustomDomain({
          enabled: state.customDomain?.enabled ?? false,
          domain: domain.trim() || undefined,
        }),
      );
    },
    [dispatch, state.customDomain?.enabled],
  );

  const handleApproveChanges = useCallback(() => {
    dispatch(actions.approveChanges({}));
  }, [dispatch]);

  const handleTerminate = useCallback(() => {
    dispatch(actions.terminateEnvironment({}));
  }, [dispatch]);

  const genericDomain = [state.genericSubdomain, state.genericBaseDomain]
    .filter(Boolean)
    .join(".");

  // ========== DRAFT VIEW ==========
  if (isDraft) {
    return (
      <div className="vetra-editor" style={containerStyle}>
        <style>{vetraThemeCSS}</style>
        <DocumentToolbar />
        <div style={headerStyle}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, color: "var(--v-fg)" }}>
              New Environment
            </h1>
            <p style={{ fontSize: 14, color: "var(--v-muted-fg)", marginTop: 4 }}>
              Initialize your Vetra Cloud environment to get started.
            </p>
          </div>
          <StatusBadge status={state.status} />
        </div>

        <SectionCard title="Initialize Environment">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Subdomain *</label>
              <input
                type="text"
                value={initSubdomain}
                onChange={(e) => setInitSubdomain(e.target.value)}
                placeholder="my-environment"
                style={inputStyle}
              />
              <span style={hintStyle}>
                Will be used as the generic subdomain for your environment
              </span>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Base Domain *</label>
              <input
                type="text"
                value={initBaseDomain}
                onChange={(e) => setInitBaseDomain(e.target.value)}
                placeholder="vetra.io"
                style={inputStyle}
              />
              <span style={hintStyle}>
                The base domain for all service URLs (e.g. vetra.io)
              </span>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Default Package Registry</label>
              <input
                type="text"
                value={initRegistry}
                onChange={(e) => setInitRegistry(e.target.value)}
                placeholder="https://registry.example.com"
                style={inputStyle}
              />
              <span style={hintStyle}>
                Optional. Default registry for packages added to this environment.
              </span>
            </div>
            <button
              onClick={handleInitialize}
              disabled={!initSubdomain.trim() || !initBaseDomain.trim()}
              style={{
                ...btnPrimaryStyle,
                alignSelf: "flex-start",
                opacity: initSubdomain.trim() && initBaseDomain.trim() ? 1 : 0.5,
              }}
            >
              Initialize Environment
            </button>
          </div>
        </SectionCard>
      </div>
    );
  }

  // ========== MAIN VIEW ==========
  return (
    <div className="vetra-editor" style={containerStyle}>
      <style>{vetraThemeCSS}</style>
      <DocumentToolbar />

      {/* ---- Environment section ---- */}
      <SectionCard title="Environment">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Name</label>
            <input
              type="text"
              defaultValue={state.label ?? ""}
              placeholder="Environment name"
              onBlur={(e) => handleSetLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={isReadonly}
              style={inputStyle}
            />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>Status</label>
            <div style={{ paddingTop: 2 }}>
              <StatusBadge status={state.status} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {state.status === "CHANGES_PENDING" && (
              <button onClick={handleApproveChanges} style={btnPrimaryStyle}>
                Approve Changes
              </button>
            )}
            {!READONLY_STATUSES.has(state.status) &&
              state.status !== "DEPLOYING" && (
                <button onClick={handleTerminate} style={btnDestructiveStyle}>
                  Terminate
                </button>
              )}
          </div>
        </div>
      </SectionCard>

      {/* ---- Domain Configuration ---- */}
      <SectionCard title="Domain Configuration">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Generic Domain</label>
            <div
              style={{
                ...inputStyle,
                background: "var(--v-accent)",
                opacity: 0.85,
                fontFamily: "monospace",
              }}
            >
              {genericDomain || "—"}
            </div>
            <span style={hintStyle}>
              Subdomain is auto-generated. Service URLs are derived from this domain.
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Subdomain</label>
              <input
                type="text"
                defaultValue={state.genericSubdomain ?? ""}
                placeholder="subdomain"
                onBlur={(e) => handleSetSubdomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                disabled={isReadonly}
                style={inputStyle}
              />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Base Domain</label>
              <input
                type="text"
                value={state.genericBaseDomain ?? ""}
                readOnly
                style={{ ...inputStyle, opacity: 0.6 }}
              />
            </div>
          </div>

          {/* Custom Domain */}
          <div
            style={{
              borderTop: "1px solid var(--v-border)",
              paddingTop: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: isReadonly ? "default" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={state.customDomain?.enabled ?? false}
                onChange={(e) => handleToggleCustomDomain(e.target.checked)}
                disabled={isReadonly}
                style={{ width: 18, height: 18, accentColor: "var(--v-primary)" }}
              />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--v-fg)" }}>
                Custom Domain
              </span>
            </label>
            {state.customDomain?.enabled && (
              <div style={fieldStyle}>
                <input
                  type="text"
                  defaultValue={state.customDomain?.domain ?? ""}
                  placeholder="project.acme.net"
                  onBlur={(e) => handleSetCustomDomainValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  disabled={isReadonly}
                  style={inputStyle}
                />
              </div>
            )}

            {/* DNS Records */}
            {state.customDomain?.dnsRecords &&
              state.customDomain.dnsRecords.length > 0 && (
                <DnsRecordsTable records={state.customDomain.dnsRecords} />
              )}
          </div>
        </div>
      </SectionCard>

      {/* ---- Reactor Modules ---- */}
      <SectionCard title="Reactor Modules">
        <PackagesList
          packages={state.packages}
          defaultRegistry={state.defaultPackageRegistry}
          dispatch={dispatch}
          disabled={isReadonly}
        />
      </SectionCard>

      {/* ---- Services ---- */}
      <SectionCard title="Services">
        <ServicesList
          services={state.services}
          genericDomain={genericDomain}
          dispatch={dispatch}
          disabled={isReadonly}
        />
      </SectionCard>

      {/* Metadata footer */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 16,
          padding: "16px 0",
          borderTop: "1px solid var(--v-border)",
          fontSize: 12,
          color: "var(--v-muted-fg)",
        }}
      >
        <div>
          <span style={metaLabelStyle}>ID</span>
          <br />
          <span style={{ fontFamily: "monospace", fontSize: 11 }}>
            {document.header.id}
          </span>
        </div>
        <div>
          <span style={metaLabelStyle}>Created</span>
          <br />
          {new Date(document.header.createdAtUtcIso).toLocaleString()}
        </div>
        <div>
          <span style={metaLabelStyle}>Modified</span>
          <br />
          {new Date(document.header.lastModifiedAtUtcIso).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

// ========== SHARED STYLES ==========

const containerStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: 32,
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  paddingBottom: 20,
  borderBottom: "1px solid var(--v-border)",
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid var(--v-border)",
  background: "var(--v-input)",
  color: "var(--v-fg)",
  fontFamily: "inherit",
  fontSize: 14,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--v-fg)",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--v-muted-fg)",
};

const metaLabelStyle: React.CSSProperties = {
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1,
};

const btnPrimaryStyle: React.CSSProperties = {
  background: "var(--v-primary)",
  color: "var(--v-primary-fg)",
  border: "none",
  borderRadius: 8,
  padding: "10px 24px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const btnDestructiveStyle: React.CSSProperties = {
  background: "var(--v-destructive)",
  color: "var(--v-destructive-fg)",
  border: "none",
  borderRadius: 8,
  padding: "10px 24px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
