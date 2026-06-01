import fs from "node:fs";
import { ensureProjectDirectories, getProjectPaths } from "../project-paths.js";

const projectPaths = ensureProjectDirectories(getProjectPaths());
const frontendDist = projectPaths.frontendDist;
const rootDist = projectPaths.rootDist;

if (!fs.existsSync(frontendDist)) {
  throw new Error(`Expected frontend build output at ${frontendDist}`);
}

fs.rmSync(rootDist, { force: true, recursive: true });
fs.cpSync(frontendDist, rootDist, { recursive: true });
