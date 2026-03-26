import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/document-models/*/tests/**",
      "**/e2e*",
    ],
  },
  plugins: [react()],
});
