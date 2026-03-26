import type { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  children: ReactNode;
}

export function SectionCard({ title, children }: SectionCardProps) {
  return (
    <div
      style={{
        background: "var(--v-card)",
        border: "1px solid var(--v-border)",
        borderRadius: 12,
        padding: 24,
      }}
    >
      <h3
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 2.5,
          color: "var(--v-muted-fg)",
          marginBottom: 16,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}
