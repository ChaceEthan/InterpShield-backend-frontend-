import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { ensureProjectDirectories, getProjectPaths } from '../project-paths.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectPaths = ensureProjectDirectories(getProjectPaths())

export default defineConfig({
  cacheDir: projectPaths.viteCache,
  plugins: [react()],
  build: {
    outDir: projectPaths.frontendDist,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
