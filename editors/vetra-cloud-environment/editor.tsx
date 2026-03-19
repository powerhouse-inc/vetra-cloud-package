import { Icon, TextInput } from "@powerhousedao/document-engineering";
import { useDocumentById } from "@powerhousedao/reactor-browser";
import { childLogger } from "document-drive";
import type { EditorProps } from "document-model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  actions,
  type VetraCloudEnvironmentDocument,
  type VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";
import { DomainConfig } from "./domain-config.js";
import { ServiceCard } from "./service-card.js";
import { generateSubdomain } from "./subdomain-generator.js";
import { useServiceHealth } from "./use-service-health.js";

const logger = childLogger(["vetra-cloud-environment-editor"]);

export type IProps = EditorProps & { documentId?: string };

const SERVICE_META: Record<
  VetraCloudEnvironmentService,
  { label: string; prefix: string; icon: "Globe" | "Connect" }
> = {
  CONNECT: { label: "Powerhouse Connect", prefix: "connect", icon: "Globe" },
  SWITCHBOARD: {
    label: "Powerhouse Switchboard",
    prefix: "switchboard",
    icon: "Connect",
  },
};

export default function Editor(props: IProps) {
  const documentId = props.documentId ?? props.document?.header.id ?? "";
  const [document, dispatch] = useDocumentById(documentId || undefined);
  const typedDocument = document as
    | VetraCloudEnvironmentDocument
    | undefined;
  const global = typedDocument?.state?.global;

  const [localName, setLocalName] = useState("");
  const [selectedServices, setSelectedServices] = useState<
    VetraCloudEnvironmentService[]
  >([]);
  const [initialized, setInitialized] = useState(false);
  const [newPackageName, setNewPackageName] = useState("");
  const [newPackageVersion, setNewPackageVersion] = useState("");
  const [moduleSearch, setModuleSearch] = useState("");

  // Track pending operations to disable buttons during gitops-triggering actions
  const [pendingStatus, setPendingStatus] = useState(false);
  const [pendingService, setPendingService] = useState<string | null>(null);
  const prevStatus = useRef(global?.status);
  const prevServices = useRef(global?.services);

  // Clear pending flags when document state catches up
  useEffect(() => {
    if (pendingStatus && global?.status !== prevStatus.current) {
      setPendingStatus(false);
    }
    prevStatus.current = global?.status;
  }, [global?.status, pendingStatus]);

  useEffect(() => {
    if (pendingService && global?.services !== prevServices.current) {
      setPendingService(null);
    }
    prevServices.current = global?.services;
  }, [global?.services, pendingService]);

  const busy = pendingStatus || pendingService !== null;

  // Initialize local state from document
  if (global && !initialized) {
    setLocalName(global.name || "");
    setSelectedServices(global.services || []);
    setInitialized(true);
  }

  // Auto-generate subdomain on first load (ref guard prevents re-dispatch loop)
  const subdomainDispatched = useRef(false);
  useEffect(() => {
    if (global && !global.subdomain && documentId && !subdomainDispatched.current) {
      subdomainDispatched.current = true;
      const subdomain = generateSubdomain(documentId);
      logger.info(`Auto-generating subdomain: ${subdomain}`);
      dispatch(actions.setSubdomain({ subdomain }));
    }
  }, [global, documentId, dispatch]);

  // Use stored subdomain, or derive one from document ID as fallback
  const subdomain = global?.subdomain ?? (documentId ? generateSubdomain(documentId) : null);
  const isRunning = global?.status === "STARTED";

  const serviceHealth = useServiceHealth(
    subdomain,
    global?.services ?? [],
    isRunning,
  );

  // Commit name on blur or Enter
  const commitName = useCallback(() => {
    const trimmed = localName.trim();
    if (trimmed && trimmed !== (global?.name ?? "")) {
      dispatch(actions.setEnvironmentName({ name: trimmed }));
    }
  }, [localName, global?.name, dispatch]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") commitName();
    },
    [commitName],
  );

  const handleCustomDomainChange = useCallback(
    (domain: string) => {
      dispatch(actions.setCustomDomain({ customDomain: domain || undefined }));
    },
    [dispatch],
  );

  const handleServiceToggle = useCallback(
    (service: VetraCloudEnvironmentService, enabled: boolean) => {
      if (busy) return;
      logger.info("Toggling service:", service, enabled);
      setPendingService(service);
      if (enabled) {
        dispatch(actions.enableService({ serviceName: service }));
        setSelectedServices((prev) => [...prev, service]);
      } else {
        dispatch(actions.disableService({ serviceName: service }));
        setSelectedServices((prev) => prev.filter((s) => s !== service));
      }
    },
    [dispatch, busy],
  );

  const handleAddPackage = useCallback(() => {
    if (newPackageName.trim()) {
      dispatch(
        actions.addPackage({
          packageName: newPackageName.trim(),
          version: newPackageVersion.trim() || undefined,
        }),
      );
      setNewPackageName("");
      setNewPackageVersion("");
    }
  }, [newPackageName, newPackageVersion, dispatch]);

  const handleRemovePackage = useCallback(
    (packageName: string) => {
      dispatch(actions.removePackage({ packageName }));
    },
    [dispatch],
  );

  const handleStartStop = useCallback(() => {
    if (busy) return;
    setPendingStatus(true);
    if (global?.status === "STARTED") {
      dispatch(actions.stop({}));
    } else {
      dispatch(actions.start({}));
    }
  }, [global?.status, dispatch, busy]);

  const filteredPackages = useMemo(() => {
    const pkgs = global?.packages ?? [];
    if (!moduleSearch.trim()) return pkgs;
    const q = moduleSearch.toLowerCase();
    return pkgs.filter((p) => p.name.toLowerCase().includes(q));
  }, [global?.packages, moduleSearch]);

  if (!global) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-500">
        Loading environment...
      </div>
    );
  }

  const statusLabel = pendingStatus
    ? isRunning ? "STOPPING..." : "STARTING..."
    : isRunning ? "ACTIVE" : "STOPPED";

  return (
    <div className="html-defaults-container w-full space-y-8 p-8">
      {/* Environment */}
      <section>
        <h1 className="mb-5 text-2xl font-bold text-gray-900">Environment</h1>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-[120px_1fr] items-center gap-y-4">
            <span className="text-sm font-medium text-gray-500">Name:</span>
            <TextInput
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={commitName}
              onKeyDown={handleNameKeyDown}
              placeholder="e.g. Acme Project - Production"
            />

            <span className="text-sm font-medium text-gray-500">Status:</span>
            <div>
              <button
                type="button"
                onClick={handleStartStop}
                disabled={busy}
                className={`inline-flex cursor-pointer items-center rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wider text-white transition-colors ${
                  busy
                    ? "cursor-not-allowed bg-amber-500"
                    : isRunning
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-gray-400 hover:bg-gray-500"
                }`}
              >
                {statusLabel}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Domain Configuration */}
      <DomainConfig
        subdomain={subdomain}
        customDomain={global.customDomain ?? null}
        onCustomDomainChange={handleCustomDomainChange}
      />

      {/* Reactor Modules */}
      <section>
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Reactor Modules
        </h2>

        <div className="relative mb-4">
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
            <Icon name="Search" size={16} />
          </div>
          <input
            type="text"
            value={moduleSearch}
            onChange={(e) => setModuleSearch(e.target.value)}
            placeholder="Search modules..."
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm shadow-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        <div className="space-y-2">
          {filteredPackages.length > 0 ? (
            filteredPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center rounded-xl border border-gray-200 bg-white px-5 py-3 shadow-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                    <Icon
                      name="PackageManager"
                      size={16}
                      className="text-gray-500"
                    />
                  </div>
                  <span className="truncate font-medium text-gray-900">
                    {pkg.name}
                  </span>
                  {pkg.version && (
                    <span className="shrink-0 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-500">
                      v{pkg.version}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleRemovePackage(pkg.name)}
                  className="ml-3 shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
                >
                  Uninstall
                </button>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/50 py-8 text-center text-sm text-gray-400">
              {moduleSearch
                ? "No modules match your search."
                : "No modules installed yet."}
            </div>
          )}
        </div>

        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4 shadow-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Add Module
          </p>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <TextInput
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                placeholder="Package name, e.g. @scope/package"
              />
            </div>
            <div className="w-28 shrink-0">
              <TextInput
                value={newPackageVersion}
                onChange={(e) => setNewPackageVersion(e.target.value)}
                placeholder="Version"
              />
            </div>
            <button
              type="button"
              onClick={handleAddPackage}
              disabled={!newPackageName.trim()}
              className="shrink-0 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Install
            </button>
          </div>
        </div>
      </section>

      {/* Services */}
      <section>
        <h2 className="mb-4 text-xl font-semibold text-gray-900">Services</h2>
        <div className="space-y-3">
          {(
            Object.entries(SERVICE_META) as [
              VetraCloudEnvironmentService,
              (typeof SERVICE_META)[VetraCloudEnvironmentService],
            ][]
          ).map(([service, meta]) => {
            const enabled = selectedServices.includes(service);
            const serviceUrl = subdomain
              ? `https://${meta.prefix}.${subdomain}.vetra.io`
              : null;
            const health =
              service === "CONNECT"
                ? serviceHealth.connect
                : serviceHealth.switchboard;

            return (
              <ServiceCard
                key={service}
                label={meta.label}
                icon={meta.icon}
                url={serviceUrl}
                enabled={enabled}
                health={health}
                disabled={busy}
                onToggle={(checked) => handleServiceToggle(service, checked)}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
