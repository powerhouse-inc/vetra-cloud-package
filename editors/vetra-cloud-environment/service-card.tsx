import { Icon, Toggle } from "@powerhousedao/document-engineering";
import type { ServiceHealth } from "./use-service-health.js";

interface ServiceCardProps {
  label: string;
  icon: "Globe" | "Connect";
  url: string | null;
  enabled: boolean;
  health: ServiceHealth;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
}

function HealthIndicator({ health }: { health: ServiceHealth }) {
  switch (health) {
    case "healthy":
      return (
        <div
          className="h-3 w-3 shrink-0 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]"
          title="Healthy"
        />
      );
    case "unhealthy":
      return (
        <div
          className="h-3 w-3 shrink-0 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]"
          title="Unhealthy"
        />
      );
    case "pending":
      return (
        <div
          className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-amber-400"
          title="Starting up..."
        />
      );
    default:
      return null;
  }
}

export function ServiceCard({
  label,
  icon,
  url,
  enabled,
  health,
  disabled,
  onToggle,
}: ServiceCardProps) {
  return (
    <div
      className={`flex items-center gap-4 rounded-xl border p-5 shadow-sm transition-all ${
        enabled
          ? "border-gray-200 bg-white"
          : "border-dashed border-gray-200 bg-gray-50/60"
      }`}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors ${
          enabled
            ? "bg-gray-900 text-white"
            : "bg-gray-200 text-gray-400"
        }`}
      >
        <Icon name={icon} size={20} />
      </div>

      <div className="min-w-0 flex-1">
        <p
          className={`font-medium ${enabled ? "text-gray-900" : "text-gray-400"}`}
        >
          {label}
        </p>
        {enabled && url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm text-blue-600 hover:underline"
          >
            {url}
          </a>
        ) : enabled ? (
          <span className="text-sm italic text-gray-400">
            Set a name to generate URL
          </span>
        ) : (
          <span className="text-sm text-gray-400">Disabled</span>
        )}
      </div>

      <HealthIndicator health={health} />

      <div className={disabled ? "pointer-events-none opacity-50" : ""}>
        <Toggle value={enabled} onChange={(checked) => onToggle(checked)} />
      </div>
    </div>
  );
}
