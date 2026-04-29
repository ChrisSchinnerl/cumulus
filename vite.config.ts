import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // sia-storage loads its WASM via `new URL(..., import.meta.url)`; excluding
  // it from the deps pre-bundler keeps that URL pointing at the real file.
  optimizeDeps: { exclude: ["@siafoundation/sia-storage"] },
  // Bind to IPv4 loopback. The atproto OAuth loopback profile only accepts
  // `http://127.0.0.1:<port>` and `http://[::1]:<port>` origins; vite's default
  // `localhost` binding can resolve to IPv6-only on macOS, breaking Safari.
  server: { host: "127.0.0.1" },
});
