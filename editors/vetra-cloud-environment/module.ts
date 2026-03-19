
import type { EditorModule } from "document-model";
import { lazy } from "react";

/** Document editor module for the "["powerhouse/vetra-cloud-environment"]" document type */
export const VetraCloudEnvironment: EditorModule = {
    Component: lazy(() => import("./editor.js")),
    documentTypes: ["powerhouse/vetra-cloud-environment"],
    config: {
        id: "vetra-cloud-environment",
        name: "Vetra Cloud Environment",
    },
};
