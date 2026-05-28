import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL?.replace(/\/$/, "");
  const socketUrl = env.VITE_SOCKET_URL?.replace(/\/$/, "") || apiUrl;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src")
      }
    },
    build: {
      outDir: "dist"
    },
    server: {
      host: "localhost",
      port: 5173,
      strictPort: true,
      proxy: apiUrl
        ? {
            "/api": apiUrl,
            "/socket.io": {
              target: socketUrl,
              ws: true,
              changeOrigin: true
            }
          }
        : undefined
    }
  };
});
