import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Server URL is injected at build time; defaults to the local dev server.
// The client reads it via import.meta.env.VITE_SERVER_URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  preview: {
    port: 5173,
  },
});
