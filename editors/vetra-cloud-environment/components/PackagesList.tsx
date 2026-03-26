import { useCallback, useState } from "react";
import type { DocumentDispatch } from "@powerhousedao/reactor-browser";
import type {
  VetraCloudEnvironmentAction,
  VetraCloudPackage,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import { actions } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--v-border)",
  background: "var(--v-input)",
  color: "var(--v-fg)",
  fontSize: 14,
  fontFamily: "inherit",
};

interface PackagesListProps {
  packages: VetraCloudPackage[];
  defaultRegistry: string | null | undefined;
  dispatch: DocumentDispatch<VetraCloudEnvironmentAction>;
  disabled?: boolean;
}

export function PackagesList({
  packages,
  defaultRegistry,
  dispatch,
  disabled,
}: PackagesListProps) {
  const [adding, setAdding] = useState(false);
  const [pkgName, setPkgName] = useState("");
  const [pkgVersion, setPkgVersion] = useState("");
  const [pkgRegistry, setPkgRegistry] = useState("");

  const handleAdd = useCallback(() => {
    if (!pkgName.trim()) return;
    dispatch(
      actions.addPackage({
        packageName: pkgName.trim(),
        version: pkgVersion.trim() || undefined,
        registry: pkgRegistry.trim() || undefined,
      }),
    );
    setPkgName("");
    setPkgVersion("");
    setPkgRegistry("");
    setAdding(false);
  }, [dispatch, pkgName, pkgVersion, pkgRegistry]);

  const handleRemove = useCallback(
    (name: string) => {
      dispatch(actions.removePackage({ packageName: name }));
    },
    [dispatch],
  );

  return (
    <div>
      {packages.length === 0 && !adding && (
        <p style={{ color: "var(--v-muted-fg)", fontSize: 14 }}>
          No modules installed. Search and install modules from the registry.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {packages.map((pkg) => (
          <div
            key={pkg.name}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              background: "var(--v-accent)",
              borderRadius: 8,
              border: "1px solid var(--v-border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "var(--v-primary-30)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                📦
              </span>
              <div>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--v-fg)" }}>
                  {pkg.name}
                </span>
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    fontFamily: "monospace",
                    color: "var(--v-primary)",
                    background: "var(--v-primary-30)",
                    padding: "1px 8px",
                    borderRadius: 4,
                    fontWeight: 600,
                  }}
                >
                  v{pkg.version ?? "latest"}
                </span>
              </div>
            </div>
            {!disabled && (
              <button
                onClick={() => handleRemove(pkg.name)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--v-destructive)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--v-fg)" }}>
              Name
            </label>
            <input
              type="text"
              value={pkgName}
              onChange={(e) => setPkgName(e.target.value)}
              placeholder="@scope/package"
              style={{ ...inputStyle, width: 220 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--v-fg)" }}>
              Version
            </label>
            <input
              type="text"
              value={pkgVersion}
              onChange={(e) => setPkgVersion(e.target.value)}
              placeholder="latest"
              style={{ ...inputStyle, width: 100 }}
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={!pkgName.trim()}
            style={{
              background: "var(--v-primary)",
              color: "var(--v-primary-fg)",
              border: "none",
              borderRadius: 8,
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              opacity: pkgName.trim() ? 1 : 0.5,
            }}
          >
            Add
          </button>
          <button
            onClick={() => setAdding(false)}
            style={{
              background: "var(--v-muted)",
              color: "var(--v-fg)",
              border: "none",
              borderRadius: 8,
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {!adding && !disabled && (
        <button
          onClick={() => setAdding(true)}
          style={{
            marginTop: 8,
            background: "transparent",
            color: "var(--v-primary)",
            border: "1px solid var(--v-primary-30)",
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Add Module
        </button>
      )}
    </div>
  );
}
