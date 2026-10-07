import type { LicenseTypeStatus } from "document-models/app-license-type/v1";

const STATUS_CONFIG: Record<
  LicenseTypeStatus,
  { label: string; dot: string; bg: string; text: string }
> = {
  DRAFT: {
    label: "Draft",
    dot: "var(--v-muted-fg)",
    bg: "var(--v-muted)",
    text: "var(--v-fg)",
  },
  ACTIVE: {
    label: "Active",
    dot: "var(--v-success)",
    bg: "var(--v-success-30)",
    text: "#1a7a33",
  },
  RETIRED: {
    label: "Retired",
    dot: "var(--v-destructive)",
    bg: "var(--v-destructive-30)",
    text: "#a32020",
  },
};

export function StatusBadge({ status }: { status: LicenseTypeStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        background: cfg.bg,
        color: cfg.text,
        borderRadius: 999,
        padding: "5px 12px",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: cfg.dot,
        }}
      />
      {cfg.label}
    </span>
  );
}
