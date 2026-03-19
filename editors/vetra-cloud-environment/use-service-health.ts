import { useEffect, useRef, useState } from "react";
import type { VetraCloudEnvironmentService } from "../../document-models/vetra-cloud-environment/index.js";

export type ServiceHealth = "off" | "pending" | "healthy" | "unhealthy";

interface ServiceHealthResult {
  connect: ServiceHealth;
  switchboard: ServiceHealth;
}

async function probeHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      mode: "no-cors",
    });
    return res.ok || res.type === "opaque";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function useServiceHealth(
  subdomain: string | null | undefined,
  services: VetraCloudEnvironmentService[],
  isRunning: boolean,
): ServiceHealthResult {
  const [health, setHealth] = useState<ServiceHealthResult>({
    connect: "off",
    switchboard: "off",
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRunning || !subdomain) {
      setHealth({ connect: "off", switchboard: "off" });
      return;
    }

    const connectEnabled = services.includes("CONNECT");
    const switchboardEnabled = services.includes("SWITCHBOARD");

    if (!connectEnabled && !switchboardEnabled) {
      setHealth({ connect: "off", switchboard: "off" });
      return;
    }

    setHealth({
      connect: connectEnabled ? "pending" : "off",
      switchboard: switchboardEnabled ? "pending" : "off",
    });

    const check = async () => {
      const [connectOk, switchboardOk] = await Promise.all([
        connectEnabled
          ? probeHealth(`https://connect.${subdomain}.vetra.io/health`)
          : Promise.resolve(false),
        switchboardEnabled
          ? probeHealth(`https://switchboard.${subdomain}.vetra.io/graphql`)
          : Promise.resolve(false),
      ]);

      setHealth({
        connect: connectEnabled
          ? connectOk ? "healthy" : "unhealthy"
          : "off",
        switchboard: switchboardEnabled
          ? switchboardOk ? "healthy" : "unhealthy"
          : "off",
      });
    };

    check();
    intervalRef.current = setInterval(check, 30_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [subdomain, services, isRunning]);

  return health;
}
