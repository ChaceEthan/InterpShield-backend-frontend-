import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url))
      }
    },
    server: {
      host: "localhost",
      port: 5173,
      strictPort: true,
      proxy: apiUrl
        ? {
            "/api": apiUrl,
            "/socket.io": {
              target: apiUrl,
              ws: true
            }
          }
        : undefined
    }
  };
});
