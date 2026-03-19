/**
 * Switchboard (Node.js) processor exports.
 * Server-only processors with Node.js dependencies go here.
 */
export { processorFactory } from "./factory.js";
export { VetraCloudEnvironmentProcessor } from "./vetra-cloud-environment/index.js";
export { vetraCloudEnvironmentProcessorFactory } from "./vetra-cloud-environment/factory.js";
