import type { EditorModule } from "document-model";
import Editor from "./editor.js";

export const module: EditorModule = {
  Component: Editor,
  documentTypes: ["powerhouse/vetra-cloud-environment"],
  config: {
    id: "vetra-cloud-environment",
    name: "Vetra Cloud Environment",
  },
};

export default module;
