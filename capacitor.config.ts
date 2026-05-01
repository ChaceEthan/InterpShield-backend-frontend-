import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.interpshield.app",
  appName: "InterpShield",
  webDir: "frontend/dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https"
  }
};

export default config;
