import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative paths matter: Electron loads the built index.html over the
  // file:// protocol, where an absolute "/assets/..." resolves to the
  // filesystem root and 404s.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});