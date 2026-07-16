// Promote a Rust firmware build to the website — a DELIBERATE, SEPARATE step from
// firmware development. Run it only when a build is validated and you want the
// site to ship it:
//
//     npm run promote-firmware            # default target: rp2040
//     npm run promote-firmware rp2350     # a specific target (when it exists)
//     npm run promote-firmware rp2040 -- path/to.uf2   # override the source UF2
//
// Firmware releases are keyed by TARGET PLATFORM (rp2040, rp2350, …), so promoting
// one target never touches the others. Each promotion copies that target's UF2
// into src/assets/led-animator-<target>.uf2 and updates its entry in
// firmwareReleases.generated.json, then regenerates the typed
// firmwareRelease.generated.ts the app imports. The version + flash layout are
// read straight from the firmware source, so the site can't drift from the device.

import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')

// Per-target build config. Add an entry when a new target's firmware build exists
// (its own crate/features, flash layout source, and UF2 family). Only `rp2040`
// ships today; the rest are placeholders showing the shape.
const TARGETS = {
  rp2040: {
    board: 'Raspberry Pi Pico W (RP2040)',
    fwRoot: resolve(repoRoot, 'firmware-rust'),
    uf2: 'led-animator.uf2', // relative to fwRoot
    versionSource: 'src/protocol.rs', // FW_VERSION lives here
    fsSource: 'src/fs.rs', // FS_BLOCK_SIZE / FS_BLOCK_COUNT / FS_OFFSET
    uf2Family: 0xe48bff56, // RP2040 UF2 family id
  },
  // rp2350: { board: 'Raspberry Pi Pico 2 W (RP2350)', fwRoot: …, uf2Family: 0xe48bff59, … },
}

const jsonPath = resolve(webRoot, 'src/export/firmwareReleases.generated.json')
const tsPath = resolve(webRoot, 'src/export/firmwareRelease.generated.ts')

function fail(msg) {
  console.error(`promote-firmware: ${msg}`)
  process.exit(1)
}

const target = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'rp2040'
const uf2Override = process.argv.find((a, i) => i >= 3 && !a.startsWith('-'))
const cfg = TARGETS[target]
if (!cfg) fail(`unknown target "${target}". Known: ${Object.keys(TARGETS).join(', ')}`)

const uf2Src = uf2Override ? resolve(uf2Override) : resolve(cfg.fwRoot, cfg.uf2)
if (!existsSync(uf2Src)) {
  fail(`no firmware UF2 at ${uf2Src}\n  build it first (cargo build --release + elf2uf2-rs), or pass a path.`)
}

/** Pull a value out of a firmware source file by regex (single source of truth). */
function grab(file, re, label) {
  const m = readFileSync(resolve(cfg.fwRoot, file), 'utf8').match(re)
  if (!m) fail(`couldn't read ${label} from ${file}`)
  return m[1]
}

const version = grab(cfg.versionSource, /FW_VERSION:\s*&str\s*=\s*"([^"]+)"/, 'FW_VERSION')
const blockSize = Number(grab(cfg.fsSource, /FS_BLOCK_SIZE:\s*usize\s*=\s*(\d+)/, 'FS_BLOCK_SIZE'))
const blockCount = Number(grab(cfg.fsSource, /FS_BLOCK_COUNT:\s*usize\s*=\s*(\d+)/, 'FS_BLOCK_COUNT'))
const fsOffsetHex = grab(cfg.fsSource, /FS_OFFSET:\s*u32\s*=\s*0x([0-9a-fA-F_]+)/, 'FS_OFFSET').replace(/_/g, '')
const fsBase = 0x10000000 + parseInt(fsOffsetHex, 16)

// Provenance: the firmware commit + whether that tree is clean.
let commit = 'unknown'
let dirty = false
try {
  commit = execFileSync('git', ['-C', cfg.fwRoot, 'rev-parse', '--short', 'HEAD']).toString().trim()
  dirty = execFileSync('git', ['-C', cfg.fwRoot, 'status', '--porcelain', '--', '.']).toString().trim().length > 0
} catch {
  /* not a git checkout */
}

const bytes = statSync(uf2Src).size
const builtAt = new Date().toISOString().slice(0, 10)

// Copy the UF2 into the (target-named) asset slot.
copyFileSync(uf2Src, resolve(webRoot, `src/assets/led-animator-${target}.uf2`))

// Merge this target into the release map (preserving the other targets).
const releases = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : {}
releases[target] = {
  target,
  board: cfg.board,
  version,
  commit,
  builtAt,
  bytes,
  uf2Family: cfg.uf2Family,
  blockSize,
  blockCount,
  fsBase,
}
writeFileSync(jsonPath, JSON.stringify(releases, null, 2) + '\n')

// Regenerate the typed TS the app imports (hex for the address/family fields).
const entries = Object.keys(releases)
  .sort()
  .map((k) => {
    const r = releases[k]
    return `  ${JSON.stringify(k)}: {
    target: ${JSON.stringify(r.target)},
    board: ${JSON.stringify(r.board)},
    version: ${JSON.stringify(r.version)},
    commit: ${JSON.stringify(r.commit)},
    builtAt: ${JSON.stringify(r.builtAt)},
    bytes: ${r.bytes},
    uf2Family: 0x${r.uf2Family.toString(16)},
    blockSize: ${r.blockSize},
    blockCount: ${r.blockCount},
    fsBase: 0x${r.fsBase.toString(16)},
  },`
  })
  .join('\n')

writeFileSync(
  tsPath,
  `// GENERATED by scripts/promote-firmware.mjs — do NOT edit by hand.
// Pinned firmware builds the website ships, keyed by target platform. Bump a
// target with \`npm run promote-firmware <target>\` when a build is ready — never
// automatically. Each target's UF2 is src/assets/led-animator-<target>.uf2.

export interface FirmwareRelease {
  /** Target platform id (matches the export DEVICES list). */
  target: string
  /** Human board name. */
  board: string
  /** What the device reports over VERSION — the site advertises the same string. */
  version: string
  /** Firmware source commit this build was promoted from. */
  commit: string
  /** Date promoted to the site (UTC, YYYY-MM-DD). */
  builtAt: string
  /** UF2 size in bytes. */
  bytes: number
  /** UF2 family id for the combined-image assembler. */
  uf2Family: number
  /** littlefs block size / count + flash base the FS image is spliced into. */
  blockSize: number
  blockCount: number
  fsBase: number
}

export const FIRMWARE_RELEASES: Record<string, FirmwareRelease> = {
${entries}
}
`,
)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`promoted "${target}" firmware to the website:`)
console.log(`  version   ${version}   (commit ${commit}${dirty ? ', TREE DIRTY' : ''})`)
console.log(`  uf2       ${kb(bytes)}  ->  src/assets/led-animator-${target}.uf2`)
console.log(`  fs        ${blockCount} × ${blockSize} B @ 0x${fsBase.toString(16)}  (family 0x${cfg.uf2Family.toString(16)})`)
console.log(`  meta      src/export/firmwareRelease.generated.ts  (+ .json store)`)
if (dirty) console.log(`\n  WARNING: ${target} firmware tree is dirty — this UF2 may not match commit ${commit}.`)
console.log('\nReview the diff, then commit the UF2 + generated files to ship it.')
