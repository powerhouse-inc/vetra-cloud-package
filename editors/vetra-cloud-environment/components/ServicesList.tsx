import { useCallback, useState } from "react";
import type { DocumentDispatch } from "@powerhousedao/reactor-browser";
import type {
  VetraCloudEnvironmentAction,
  VetraCloudEnvironmentService,
  VetraCloudEnvironmentServiceType,
  ServiceStatus,
} from "document-models/vetra-cloud-environment/v1";
import { actions } from "document-models/vetra-cloud-environment/v1";

const SERVICE_TYPES: VetraCloudEnvironmentServiceType[] = [
  "CONNECT",
  "SWITCHBOARD",
  "FUSION",
  "CLINT",
];

const SERVICE_LABELS: Record<VetraCloudEnvironmentServiceType, string> = {
  CONNECT: "Powerhouse Connect",
  SWITCHBOARD: "Powerhouse Switchboard",
  FUSION: "Fusion",
  CLINT: "Agent",
};

const DEFAULT_PREFIXES: Record<VetraCloudEnvironmentServiceType, string> = {
  CONNECT: "connect",
  SWITCHBOARD: "switchboard",
  FUSION: "fusion",
  CLINT: "agent",
};

const SERVICE_STATUS_COLORS: Record<ServiceStatus, { dot: string; label: string }> = {
  ACTIVE: { dot: "var(--v-primary)", label: "Active" },
  PROVISIONING: { dot: "var(--v-progress)", label: "Provisioning" },
  SUSPENDED: { dot: "var(--v-todo)", label: "Suspended" },
  BILLING_ISSUE: { dot: "var(--v-destructive)", label: "Billing Issue" },
};

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--v-border)",
  background: "var(--v-input)",
  color: "var(--v-fg)",
  fontSize: 14,
  fontFamily: "inherit",
};

interface ServicesListProps {
  services: VetraCloudEnvironmentService[];
  genericDomain: string;
  dispatch: DocumentDispatch<VetraCloudEnvironmentAction>;
  disabled?: boolean;
}

export function ServicesList({
  services,
  genericDomain,
  dispatch,
  disabled,
}: ServicesListProps) {
  const [addingService, setAddingService] = useState(false);
  const [selectedType, setSelectedType] =
    useState<VetraCloudEnvironmentServiceType>("CONNECT");
  const [prefix, setPrefix] = useState("");

  const enabledTypes = new Set(services.map((s) => s.type));
  const availableTypes = SERVICE_TYPES.filter((t) => !enabledTypes.has(t));

  const handleAdd = useCallback(() => {
    if (!selectedType || !prefix.trim()) return;
    dispatch(
      actions.enableService({ type: selectedType, prefix: prefix.trim() }),
    );
    setAddingService(false);
    setPrefix("");
  }, [dispatch, selectedType, prefix]);

  const handleToggle = useCallback(
    (type: VetraCloudEnvironmentServiceType) => {
      dispatch(actions.toggleService({ type }));
    },
    [dispatch],
  );

  return (
    <div>
      {services.length === 0 && !addingService && (
        <p style={{ color: "var(--v-muted-fg)", fontSize: 14 }}>
          No services configured
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {services.map((service) => {
          const serviceUrl =
            service.url ||
            (genericDomain
              ? `https://${service.prefix}.${genericDomain}`
              : null);
          const statusInfo = SERVICE_STATUS_COLORS[service.status];
          return (
            <div
              key={service.type}
              style={{
                padding: "14px 16px",
                background: service.enabled ? "var(--v-card)" : "var(--v-accent)",
                borderRadius: 10,
                border: "1px solid var(--v-border)",
                opacity: service.enabled ? 1 : 0.6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--v-fg)" }}>
                    {SERVICE_LABELS[service.type]}
                  </span>
                  {/* Service status badge */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      fontWeight: 600,
                      color: statusInfo.dot,
                      background: "var(--v-accent)",
                      padding: "2px 8px",
                      borderRadius: 10,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: statusInfo.dot,
                      }}
                    />
                    {statusInfo.label}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Toggle switch */}
                  {!disabled && (
                    <button
                      onClick={() => handleToggle(service.type)}
                      style={{
                        width: 44,
                        height: 24,
                        borderRadius: 12,
                        border: "none",
                        background: service.enabled
                          ? "var(--v-primary)"
                          : "var(--v-border)",
                        cursor: "pointer",
                        position: "relative",
                        transition: "background 0.2s",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 3,
                          left: service.enabled ? 23 : 3,
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          background: "white",
                          transition: "left 0.2s",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                        }}
                      />
                    </button>
                  )}
                </div>
              </div>
              {/* Service URL */}
              {serviceUrl && (
                <a
                  href={serviceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "block",
                    marginTop: 6,
                    fontSize: 13,
                    fontFamily: "monospace",
                    color: "var(--v-primary)",
                    textDecoration: "none",
                  }}
                >
                  {serviceUrl}
                </a>
              )}
            </div>
          );
        })}
      </div>

      {addingService && availableTypes.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--v-fg)" }}>
              Type
            </label>
            <select
              value={selectedType}
              onChange={(e) => {
                const type = e.target.value as VetraCloudEnvironmentServiceType;
                setSelectedType(type);
                setPrefix(DEFAULT_PREFIXES[type]);
              }}
              style={inputStyle}
            >
              {availableTypes.map((type) => (
                <option key={type} value={type}>
                  {SERVICE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--v-fg)" }}>
              Prefix
            </label>
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="e.g. connect"
              style={{ ...inputStyle, width: 160 }}
            />
            <span style={{ fontSize: 11, color: "var(--v-muted-fg)" }}>
              Prefix can be configured by the user
            </span>
          </div>
          <button
            onClick={handleAdd}
            disabled={!prefix.trim()}
            style={{
              background: "var(--v-primary)",
              color: "var(--v-primary-fg)",
              border: "none",
              borderRadius: 8,
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              opacity: prefix.trim() ? 1 : 0.5,
            }}
          >
            Add
          </button>
          <button
            onClick={() => setAddingService(false)}
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

      {!addingService && !disabled && availableTypes.length > 0 && (
        <button
          onClick={() => {
            setSelectedType(availableTypes[0]);
            setPrefix(DEFAULT_PREFIXES[availableTypes[0]]);
            setAddingService(true);
          }}
          style={{
            marginTop: 10,
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
          + Add Service
        </button>
      )}
    </div>
  );
}
