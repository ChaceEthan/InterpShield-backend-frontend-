import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiUrl = env.VITE_API_URL?.trim().replace(/\/$/, "");

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
      proxy: apiUrl
        ? {
            "/api": {
              target: apiUrl,
              changeOrigin: true
            },
            "/socket.io": {
              target: apiUrl,
              changeOrigin: true,
              ws: true
            }
          }
        : undefined
    }
  };
});
