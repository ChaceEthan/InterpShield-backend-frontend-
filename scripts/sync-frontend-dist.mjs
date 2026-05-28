import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDist = path.join(repoRoot, "frontend", "dist");
const rootDist = path.join(repoRoot, "dist");

if (!fs.existsSync(frontendDist)) {
  throw new Error(`Expected frontend build output at ${frontendDist}`);
}

fs.rmSync(rootDist, { force: true, recursive: true });
fs.cpSync(frontendDist, rootDist, { recursive: true });
