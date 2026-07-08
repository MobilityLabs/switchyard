import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:3300",
      "/auth": "http://localhost:3300",
    },
  },
});
