import {
  Icon,
  TextInput,
  Toggle,
} from "@powerhousedao/document-engineering";
import { useDocumentById } from "@powerhousedao/reactor-browser";
import { childLogger } from "document-drive";
import type { EditorProps } from "document-model";
import { useCallback, useMemo, useState } from "react";
import {
  actions,
  type VetraCloudEnvironmentDocument,
  type VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";

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

  const [environmentName, setEnvironmentName] = useState("");
  const [selectedServices, setSelectedServices] = useState<
    VetraCloudEnvironmentService[]
  >([]);
  const [initialized, setInitialized] = useState(false);
  const [newPackageName, setNewPackageName] = useState("");
  const [newPackageVersion, setNewPackageVersion] = useState("");
  const [moduleSearch, setModuleSearch] = useState("");

  if (global && !initialized) {
    setEnvironmentName(global.name || "");
    setSelectedServices(global.services || []);
    setInitialized(true);
  }

  const baseDomain = useMemo(() => {
    const name = environmentName.trim();
    if (!name) return null;
    return `${name}.vetra.io`;
  }, [environmentName]);

  const handleNameChange = useCallback(
    (name: string) => {
      setEnvironmentName(name);
      if (name.trim()) {
        try {
          dispatch(actions.setEnvironmentName({ name: name.trim() }));
        } catch (error) {
          console.error("Failed to set environment name:", error);
        }
      }
    },
    [dispatch],
  );

  const handleServiceToggle = useCallback(
    (service: VetraCloudEnvironmentService, enabled: boolean) => {
      logger.info("Toggling service:", service, enabled);
      if (enabled) {
        dispatch(actions.enableService({ serviceName: service }));
        setSelectedServices((prev) => [...prev, service]);
      } else {
        dispatch(actions.disableService({ serviceName: service }));
        setSelectedServices((prev) => prev.filter((s) => s !== service));
      }
    },
    [dispatch],
  );

  const handleAddPackage = useCallback(() => {
    if (newPackageName.trim()) {
      try {
        dispatch(
          actions.addPackage({
            packageName: newPackageName.trim(),
            version: newPackageVersion.trim() || undefined,
          }),
        );
        setNewPackageName("");
        setNewPackageVersion("");
      } catch (error) {
        console.error("Failed to add package:", error);
      }
    }
  }, [newPackageName, newPackageVersion, dispatch]);

  const handleRemovePackage = useCallback(
    (packageName: string) => {
      try {
        dispatch(actions.removePackage({ packageName }));
      } catch (error) {
        console.error("Failed to remove package:", error);
      }
    },
    [dispatch],
  );

  const handleStartStop = useCallback(() => {
    try {
      if (global?.status === "STARTED") {
        dispatch(actions.stop({}));
      } else {
        dispatch(actions.start({}));
      }
    } catch (error) {
      console.error("Failed to start/stop environment:", error);
    }
  }, [global?.status, dispatch]);

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

  const isRunning = global.status === "STARTED";

  return (
    <div className="html-defaults-container w-full space-y-10 p-8">
      {/* ── Environment ── */}
      <section>
        <h1 className="mb-6 text-2xl font-bold text-gray-900">Environment</h1>

        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-[120px_1fr] items-center gap-y-5">
            <span className="text-sm font-medium text-gray-500">Name:</span>
            <TextInput
              value={environmentName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Acme Project - Production"
            />

            <span className="text-sm font-medium text-gray-500">Status:</span>
            <div>
              <button
                type="button"
                onClick={handleStartStop}
                className={`inline-flex cursor-pointer items-center rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wider text-white transition-colors ${
                  isRunning
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-gray-400 hover:bg-gray-500"
                }`}
              >
                {isRunning ? "ACTIVE" : "STOPPED"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Domain Configuration ── */}
      <section>
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Domain Configuration
        </h2>

        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-[120px_1fr] items-center">
            <span className="text-sm font-medium text-gray-500">
              Generic Domain:
            </span>
            {baseDomain ? (
              <span className="font-mono text-sm text-gray-800">
                {baseDomain}
              </span>
            ) : (
              <span className="text-sm italic text-gray-400">
                Set a name above to generate domain
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ── Reactor Modules ── */}
      <section>
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Reactor Modules
        </h2>

        {/* Search bar */}
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

        {/* Module list */}
        <div className="space-y-2">
          {filteredPackages.length > 0 ? (
            filteredPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center rounded-xl border border-gray-200 bg-white px-5 py-3.5 shadow-sm"
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
                      v. {pkg.version}
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
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/50 py-10 text-center text-sm text-gray-400">
              {moduleSearch
                ? "No modules match your search."
                : "No modules installed yet."}
            </div>
          )}
        </div>

        {/* Add module form */}
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5 shadow-sm">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
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

      {/* ── Services ── */}
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
            const serviceUrl = baseDomain
              ? `https://${meta.prefix}.${baseDomain}`
              : null;

            return (
              <div
                key={service}
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
                  <Icon name={meta.icon} size={20} />
                </div>

                <div className="min-w-0 flex-1">
                  <p
                    className={`font-medium ${enabled ? "text-gray-900" : "text-gray-400"}`}
                  >
                    {meta.label}
                  </p>
                  {enabled && serviceUrl ? (
                    <a
                      href={serviceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm text-blue-600 hover:underline"
                    >
                      {serviceUrl}
                    </a>
                  ) : enabled ? (
                    <span className="text-sm italic text-gray-400">
                      Set a name to generate URL
                    </span>
                  ) : (
                    <span className="text-sm text-gray-400">Disabled</span>
                  )}
                </div>

                {enabled && isRunning && (
                  <div
                    className="h-3 w-3 shrink-0 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]"
                    title="Running"
                  />
                )}

                <Toggle
                  value={enabled}
                  onChange={(checked) => handleServiceToggle(service, checked)}
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
