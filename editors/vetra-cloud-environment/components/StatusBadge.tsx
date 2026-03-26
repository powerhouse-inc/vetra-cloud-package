import type { VetraCloudEnvironmentStatus } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

const STATUS_CONFIG: Record<
  VetraCloudEnvironmentStatus,
  { label: string; dot: string; bg: string; text: string }
> = {
  DRAFT: {
    label: "Draft",
    dot: "var(--v-muted-fg)",
    bg: "var(--v-muted)",
    text: "var(--v-fg)",
  },
  CHANGES_PENDING: {
    label: "Changes Pending",
    dot: "var(--v-todo)",
    bg: "var(--v-todo-30)",
    text: "#b37100",
  },
  CHANGES_APPROVED: {
    label: "Changes Approved",
    dot: "var(--v-success)",
    bg: "var(--v-success-30)",
    text: "#1a7a33",
  },
  CHANGES_PUSHED: {
    label: "Changes Pushed",
    dot: "var(--v-progress)",
    bg: "var(--v-progress-30)",
    text: "#1a6abf",
  },
  DEPLOYING: {
    label: "Deploying",
    dot: "var(--v-progress)",
    bg: "var(--v-progress-30)",
    text: "#1a6abf",
  },
  DEPLOYMENt_FAILED: {
    label: "Deployment Failed",
    dot: "var(--v-destructive)",
    bg: "var(--v-destructive-30)",
    text: "var(--v-destructive)",
  },
  READY: {
    label: "Ready",
    dot: "var(--v-primary)",
    bg: "var(--v-primary-30)",
    text: "#038a46",
  },
  TERMINATING: {
    label: "Terminating",
    dot: "var(--v-destructive)",
    bg: "var(--v-destructive-30)",
    text: "var(--v-destructive)",
  },
  DESTROYED: {
    label: "Destroyed",
    dot: "var(--v-fg-70)",
    bg: "var(--v-muted)",
    text: "var(--v-fg-70)",
  },
  ARCHIVED: {
    label: "Archived",
    dot: "var(--v-purple)",
    bg: "var(--v-purple-30)",
    text: "var(--v-purple)",
  },
};

interface StatusBadgeProps {
  status: VetraCloudEnvironmentStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 14px",
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 600,
        background: config.bg,
        color: config.text,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: config.dot,
          flexShrink: 0,
        }}
      />
      {config.label}
    </span>
  );
}
