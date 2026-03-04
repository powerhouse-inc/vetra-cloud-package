import { Button, Select, TextInput } from "@powerhousedao/document-engineering";
import { useDocumentById } from "@powerhousedao/reactor-browser";
import { childLogger } from "document-drive";
import type { EditorProps } from "document-model";
import { useCallback, useState } from "react";
import {
  actions,
  type VetraCloudEnvironmentDocument,
  type VetraCloudEnvironmentService
} from "../../document-models/vetra-cloud-environment/index.js";

const logger = childLogger(["vetra-cloud-environment-editor"]);

export type IProps = EditorProps;

export default function Editor(props: IProps) {
  const [document, dispatch] = useDocumentById(props.document.header.id)
  const unsafeCastOfDocument = document as VetraCloudEnvironmentDocument;
  const { state: { global } } = unsafeCastOfDocument;
  
  // Local form stateF
  const [environmentName, setEnvironmentName] = useState(unsafeCastOfDocument.state.global.name || "");
  const [selectedServices, setSelectedServices] = useState<VetraCloudEnvironmentService[]>(
    global.services || []
  );
  const [newPackageName, setNewPackageName] = useState("");
  const [newPackageVersion, setNewPackageVersion] = useState("");

  // Available services
  const availableServices: VetraCloudEnvironmentService[] = ["CONNECT", "SWITCHBOARD"];

  // Handle environment name change
  const handleNameChange = useCallback((name: string) => {
    setEnvironmentName(name);
    if (name.trim()) {
      try {
        dispatch(actions.setEnvironmentName({ name: name.trim() }));
      } catch (error) {
        console.error("Failed to set environment name:", error);
      }
    }
  }, []);

  // Handle service toggle
  const handleServiceToggle = useCallback((services: VetraCloudEnvironmentService[]) => {
    logger.info("Toggling services:", services);
    for(const activatedService of selectedServices) {
      if(services.includes(activatedService)) {
        logger.info("Disabling service:", activatedService);
        dispatch(actions.disableService({ serviceName: activatedService }));
      }
    }

    for(const deactivatedService of services) {
      if(!selectedServices.includes(deactivatedService)) {
        logger.info("Enabling service:", deactivatedService);
        dispatch(actions.enableService({ serviceName: deactivatedService }));
      }
    }

    setSelectedServices(services);
  }, [selectedServices, dispatch]);

  // Handle package addition
  const handleAddPackage = useCallback(() => {
    if (newPackageName.trim()) {
      try {
        dispatch(actions.addPackage({
          packageName: newPackageName.trim(),
          version: newPackageVersion.trim() || undefined
        }));
        setNewPackageName("");
        setNewPackageVersion("");
      } catch (error) {
        console.error("Failed to add package:", error);
      }
    }
  }, [newPackageName, newPackageVersion, dispatch]);

  // Handle package removal
  const handleRemovePackage = useCallback((packageName: string) => {
    try {
      dispatch(actions.removePackage({ packageName }));
    } catch (error) {
      console.error("Failed to remove package:", error);
    }
  }, [dispatch]);

  // Handle start/stop
  const handleStartStop = useCallback(() => {
    try {
      if (global.status === "STARTED") {
        dispatch(actions.stop({}));
      } else {
        dispatch(actions.start({}));
      }
    } catch (error) {
      console.error("Failed to start/stop environment:", error);
    }
  }, [global.status, dispatch]);

  // Generate endpoints
  const generateEndpoints = useCallback(() => {
    if (!environmentName.trim()) return [];
    
    const baseUrl = `${environmentName.trim()}.demo.powerhouse.io`;
    const endpoints = [];
    
    if (selectedServices.includes("CONNECT")) {
      endpoints.push({
        service: "Connect",
        url: `https://${baseUrl}`,
        description: "Connect service endpoint"
      });
    }
    
    if (selectedServices.includes("SWITCHBOARD")) {
      endpoints.push({
        service: "Switchboard",
        url: `https://${baseUrl}/api/graphql`,
        description: "Switchboard GraphQL API endpoint"
      });
    }
    
    return endpoints;
  }, [environmentName, selectedServices]);

  const endpoints = generateEndpoints();
  const isRunning = global.status === "STARTED";

  return (
    <div className="html-defaults-container container mx-auto max-w-4xl p-8">
      <div className="mb-8">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">
          Vetra Cloud Environment Manager
        </h1>
        <p className="mb-4 text-gray-600">
          Manage your cloud environment configuration, services, and packages.
        </p>
      </div>

      {/* Environment Info */}
      <div className="mb-8 rounded-lg bg-gray-50 p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Environment Information
          </h3>
          {/* Status Badge */}
          <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${
            isRunning 
              ? "bg-green-100 text-green-800" 
              : "bg-red-100 text-red-800"
          }`}>
            <div className={`h-2 w-2 rounded-full ${
              isRunning ? "bg-green-500" : "bg-red-500"
            }`} />
            {isRunning ? "Running" : "Stopped"}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="flex justify-between">
            <span className="font-medium text-gray-600">Name:</span>
            <span className="text-gray-900">{global.name || "Not set"}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-medium text-gray-600">Services:</span>
            <span className="text-gray-900">{global.services.length} enabled</span>
          </div>
          <div className="flex justify-between">
            <span className="font-medium text-gray-600">Packages:</span>
            <span className="text-gray-900">{global.packages?.length || 0} installed</span>
          </div>
        </div>
        
        {/* Service Links */}
        {endpoints.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Service Links</h4>
            <div className="flex flex-wrap gap-2">
              {endpoints.map((endpoint, index) => (
                <a
                  key={index}
                  href={endpoint.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 bg-blue-100 hover:bg-blue-200 text-blue-800 text-sm font-medium rounded-lg transition-colors duration-200"
                >
                  <span>{endpoint.service}</span>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Start/Stop Section */}
      <div className="mb-8 text-center">
        <Button
          onClick={handleStartStop}
          color={isRunning ? "red" : "blue"}
          size="default"
          variant={isRunning ? "destructive" : "default"}
        >
          {isRunning ? "🛑 Stop Environment" : "▶️ Start Environment"}
        </Button>
      </div>

      {/* Environment Name Section */}
      <div className="mb-8 rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Environment Configuration
        </h2>
        <div className="space-y-4">
          <div>
            <TextInput
              label="Environment Name"
              value={environmentName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Enter environment name (e.g., my-project)"
            />
            <p className="mt-2 text-sm text-gray-500">
              This will be used to generate your endpoints: &lt;name&gt;.demo.powerhouse.io
            </p>
          </div>
        </div>
      </div>

      {/* Services Section */}
      <div className="mb-8 rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Powerhouse Services
        </h2>
        <div className="space-y-3">
          <Select
            options={availableServices.map((service) => ({
              label: service === "CONNECT" ? "Connect" : "Switchboard",
              value: service,
            }))}
            multiple
            value={selectedServices}
            id="services"
            onChange={(value) => handleServiceToggle(value as VetraCloudEnvironmentService[])}
          />
        </div>
      </div>

      {/* Packages Section */}
      <div className="mb-8 rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 className="mb-4 text-xl font-semibold text-gray-900">
          Package Management
        </h2>
        
        {/* Add Package Form */}
        <div className="mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <TextInput
                type="text"
                label="Package Name"
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                placeholder="Package name"
              />
            </div>
            <div>
              <TextInput
                type="text"
                label="Version (optional)"
                value={newPackageVersion}
                onChange={(e) => setNewPackageVersion(e.target.value)}
                placeholder="Version (optional)"
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleAddPackage}
                disabled={!newPackageName.trim()}
                color="blue"
                className="w-full"
              >
                Add Package
              </Button>
            </div>
          </div>
        </div>

        {/* Package List */}
        <div>
          {global.packages && global.packages.length > 0 ? (
            <div className="space-y-2">
              {global.packages.map((pkg, index) => (
                <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{pkg.name}</span>
                    {pkg.version && (
                      <span className="text-sm text-gray-500 bg-gray-200 px-2 py-1 rounded">
                        v{pkg.version}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={() => handleRemovePackage(pkg.name)}
                    color="red"
                    size="sm"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <p>No packages added yet. Add packages to extend your environment functionality.</p>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
