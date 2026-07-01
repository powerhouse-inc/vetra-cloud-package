import type { DnsRecord } from "document-models/vetra-cloud-environment/v1";

interface DnsRecordsTableProps {
  records: DnsRecord[];
}

const thStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontWeight: 600,
  fontSize: 11,
  color: "var(--v-muted-fg)",
  textTransform: "uppercase",
  letterSpacing: 1,
  textAlign: "left",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  fontFamily: "monospace",
  color: "var(--v-fg)",
};

export function DnsRecordsTable({ records }: DnsRecordsTableProps) {
  return (
    <div style={{ marginTop: 4 }}>
      <label
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--v-muted-fg)",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
          display: "block",
        }}
      >
        DNS Records
      </label>
      <div
        style={{
          border: "1px solid var(--v-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--v-accent)" }}>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Host</th>
              <th style={thStyle}>Value</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr
                key={`${r.host}-${i}`}
                style={i > 0 ? { borderTop: "1px solid var(--v-border)" } : undefined}
              >
                <td style={{ ...tdStyle, fontWeight: 600, width: 70 }}>{r.type}</td>
                <td style={tdStyle}>{r.host}</td>
                <td style={tdStyle}>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
