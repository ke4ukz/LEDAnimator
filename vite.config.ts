import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function gitCommit(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim()
    const dirty = execSync('git status --porcelain').toString().trim().length > 0
    return dirty ? `${hash}+` : hash
  } catch {
    return 'nogit'
  }
}

/**
 * Exposes build info as `virtual:build-info`. A virtual module works in both
 * dev and production (unlike `define`, which Vite 8 didn't replace in dev here).
 * In dev the values are stamped when the server starts.
 */
function buildInfo(): Plugin {
  const id = 'virtual:build-info'
  const resolved = '\0' + id
  return {
    name: 'build-info',
    resolveId: (s) => (s === id ? resolved : undefined),
    load: (s) =>
      s === resolved
        ? `export const commit = ${JSON.stringify(gitCommit())}
export const buildTime = ${JSON.stringify(new Date().toISOString())}`
        : undefined,
  }
}

// Relative base so the build works on GitHub Pages project sites
// (https://<user>.github.io/<repo>/) regardless of the repo name.
// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), buildInfo()],
})
