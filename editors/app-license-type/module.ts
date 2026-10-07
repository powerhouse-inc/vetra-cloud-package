import type { EditorModule } from "document-model";
import { lazy } from "react";

/** Document editor module for the "powerhouse/app-license-type" document type */
export const AppLicenseType: EditorModule = {
  Component: lazy(() => import("./editor.js")),
  documentTypes: ["powerhouse/app-license-type"],
  config: {
    id: "app-license-type",
    name: "app-license-type",
  },
};
