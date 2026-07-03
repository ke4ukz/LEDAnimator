import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import licensePlugin from 'rollup-plugin-license'
import type { Dependency, Options as LicenseOptions } from 'rollup-plugin-license'
import type { Plugin as RollupPlugin } from 'rollup'

// rollup-plugin-license is CJS; under nodenext + verbatimModuleSyntax TS
// mis-types the default export as non-callable, though at runtime it is the
// function. Cast to the shape we use.
const license = licensePlugin as unknown as (options: LicenseOptions) => RollupPlugin

// The bundled Pico W firmware isn't an npm dependency, so add its notice by hand.
const MICROPYTHON_NOTICE = `Name: MicroPython (Raspberry Pi Pico W firmware, v1.28.0)
License: MIT
Repository: https://github.com/micropython/micropython

LED Animator bundles the stock MicroPython UF2 firmware for the Raspberry Pi
Pico W and embeds it into exported UF2 images. MicroPython is distributed under
the MIT License (Copyright (c) 2013-2024 Damien P. George and contributors). The
firmware also incorporates components (e.g. TinyUSB, lwIP, the Raspberry Pi Pico
SDK) under their own permissive licenses; see the LICENSE files in the
MicroPython repository for the complete text.`

function renderDep(d: Dependency): string {
  const head = [
    `Name: ${d.name}`,
    d.version ? `Version: ${d.version}` : null,
    `License: ${d.license ?? 'UNKNOWN'}`,
    d.homepage ? `Homepage: ${d.homepage}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  const text = (d.licenseText ?? d.noticeText ?? '').trim()
  return `${head}\n\n${text || '(no license text provided)'}`
}

function renderNotices(deps: Dependency[]): string {
  const header =
    'LED Animator — third-party open-source notices\n\n' +
    'The following open-source components are bundled in this application:'
  const body = deps.map(renderDep).join('\n\n---\n\n')
  return `${header}\n\n---\n\n${body}\n\n---\n\n${MICROPYTHON_NOTICE}\n`
}

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
  build: {
    rollupOptions: {
      // Emit a third-party license notices file covering exactly what ends up
      // in the bundle (transitive deps included). Linked from the app footer to
      // satisfy the MIT/BSD/ISC attribution requirements of our dependencies.
      plugins: [
        license({
          thirdParty: {
            output: {
              file: fileURLToPath(new URL('dist/third-party-notices.txt', import.meta.url)),
              template: renderNotices,
            },
          },
        }),
      ],
    },
  },
})
