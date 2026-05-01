import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL || "http://localhost:5000";

  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        checks: {
          pluginTimings: false
        }
      }
    },
    server: {
      hmr: process.env.DISABLE_HMR !== "true",
      proxy: {
        "/api": apiUrl,
        "/socket.io": {
          target: apiUrl,
          ws: true
        }
      }
    }
  };
});
