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

// Per-target build config. Add an entry when a new target's firmware build exists.
// `format` is the artifact type the target ships — NOT every target is a UF2:
//   'uf2' (RP2040/RP2350, spliced with a littlefs image) · 'hex' (ATmega) ·
//   'img' (Pi disk image) · 'bin' (ESP32) · …
// `combinedUf2` is present ONLY for the UF2 + littlefs model (family + FS layout,
// read from the firmware source). Other formats omit it and add their own fields.
// Only `rp2040` ships today; the commented entries show the shape.
const TARGETS = {
  rp2040: {
    board: 'Raspberry Pi Pico W (RP2040)',
    format: 'uf2',
    fwRoot: resolve(repoRoot, 'firmware-rust'),
    artifact: 'led-animator.uf2', // built file, relative to fwRoot
    versionSource: 'src/protocol.rs', // FW_VERSION lives here
    combinedUf2: {
      family: 0xe48bff56, // RP2040 UF2 family id
      fsSource: 'src/fs.rs', // FS_BLOCK_SIZE / FS_BLOCK_COUNT / FS_OFFSET
    },
  },
  // rp2350:    { board: 'Pico 2 W (RP2350)', format: 'uf2', combinedUf2: { family: 0xe48bff59, … }, … },
  // atmega328: { board: 'Arduino Uno/Nano', format: 'hex', fwRoot: …, artifact: 'led-animator.hex' },
  // pi:        { board: 'Raspberry Pi', format: 'img', … },
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

const artifactSrc = uf2Override ? resolve(uf2Override) : resolve(cfg.fwRoot, cfg.artifact)
if (!existsSync(artifactSrc)) {
  fail(`no firmware artifact at ${artifactSrc}\n  build it first, or pass a path.`)
}

/** Pull a value out of a firmware source file by regex (single source of truth). */
function grab(file, re, label) {
  const m = readFileSync(resolve(cfg.fwRoot, file), 'utf8').match(re)
  if (!m) fail(`couldn't read ${label} from ${file}`)
  return m[1]
}

const version = grab(cfg.versionSource, /FW_VERSION:\s*&str\s*=\s*"([^"]+)"/, 'FW_VERSION')

// Combined-UF2 (family + littlefs splice params) only for the UF2 + FS model.
let combinedUf2
if (cfg.combinedUf2) {
  const fsSrc = cfg.combinedUf2.fsSource
  const fsOffsetHex = grab(fsSrc, /FS_OFFSET:\s*u32\s*=\s*0x([0-9a-fA-F_]+)/, 'FS_OFFSET').replace(/_/g, '')
  combinedUf2 = {
    family: cfg.combinedUf2.family,
    blockSize: Number(grab(fsSrc, /FS_BLOCK_SIZE:\s*usize\s*=\s*(\d+)/, 'FS_BLOCK_SIZE')),
    blockCount: Number(grab(fsSrc, /FS_BLOCK_COUNT:\s*usize\s*=\s*(\d+)/, 'FS_BLOCK_COUNT')),
    fsBase: 0x10000000 + parseInt(fsOffsetHex, 16),
  }
}

// Provenance: the firmware commit + whether that tree is clean.
let commit = 'unknown'
let dirty = false
try {
  commit = execFileSync('git', ['-C', cfg.fwRoot, 'rev-parse', '--short', 'HEAD']).toString().trim()
  dirty = execFileSync('git', ['-C', cfg.fwRoot, 'status', '--porcelain', '--', '.']).toString().trim().length > 0
} catch {
  /* not a git checkout */
}

const bytes = statSync(artifactSrc).size
const builtAt = new Date().toISOString().slice(0, 10)
const file = `led-animator-${target}.${cfg.format}` // asset name, extension = format

// Copy the artifact into the (target-named, correctly-extensioned) asset slot.
copyFileSync(artifactSrc, resolve(webRoot, 'src/assets', file))

// Merge this target into the release map (preserving the other targets).
const releases = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : {}
releases[target] = {
  target,
  board: cfg.board,
  format: cfg.format,
  file,
  version,
  commit,
  builtAt,
  bytes,
  ...(combinedUf2 ? { combinedUf2 } : {}),
}
writeFileSync(jsonPath, JSON.stringify(releases, null, 2) + '\n')

// Regenerate the typed TS the app imports (hex for the address/family fields).
const entries = Object.keys(releases)
  .sort()
  .map((k) => {
    const r = releases[k]
    const cu = r.combinedUf2
      ? `
    combinedUf2: { family: 0x${r.combinedUf2.family.toString(16)}, blockSize: ${r.combinedUf2.blockSize}, blockCount: ${r.combinedUf2.blockCount}, fsBase: 0x${r.combinedUf2.fsBase.toString(16)} },`
      : ''
    return `  ${JSON.stringify(k)}: {
    target: ${JSON.stringify(r.target)},
    board: ${JSON.stringify(r.board)},
    format: ${JSON.stringify(r.format)},
    file: ${JSON.stringify(r.file)},
    version: ${JSON.stringify(r.version)},
    commit: ${JSON.stringify(r.commit)},
    builtAt: ${JSON.stringify(r.builtAt)},
    bytes: ${r.bytes},${cu}
  },`
  })
  .join('\n')

writeFileSync(
  tsPath,
  `// GENERATED by scripts/promote-firmware.mjs — do NOT edit by hand.
// Pinned firmware builds the website ships, keyed by target platform. Bump a
// target with \`npm run promote-firmware <target>\` when a build is ready — never
// automatically. Each target's artifact is src/assets/<file> (extension varies by
// format: uf2 / hex / img / bin …).

/** Combined-UF2 build params — present only for the UF2 + spliced-littlefs model
 *  (RP2040 / RP2350). Other artifact formats omit this. */
export interface CombinedUf2 {
  /** UF2 family id for the assembler. */
  family: number
  /** littlefs block size / count + flash base the FS image is spliced into. */
  blockSize: number
  blockCount: number
  fsBase: number
}

export interface FirmwareRelease {
  /** Target platform id (matches the export DEVICES list). */
  target: string
  /** Human board name. */
  board: string
  /** Artifact type the target ships: 'uf2' | 'hex' | 'img' | 'bin' | … */
  format: string
  /** Asset filename in src/assets/ (extension matches \`format\`). */
  file: string
  /** What the device reports over VERSION — the site advertises the same string. */
  version: string
  /** Firmware source commit this build was promoted from. */
  commit: string
  /** Date promoted to the site (UTC, YYYY-MM-DD). */
  builtAt: string
  /** Artifact size in bytes. */
  bytes: number
  /** UF2 + littlefs params (UF2-family targets only). */
  combinedUf2?: CombinedUf2
}

export const FIRMWARE_RELEASES: Record<string, FirmwareRelease> = {
${entries}
}
`,
)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`promoted "${target}" firmware to the website:`)
console.log(`  version   ${version}   (commit ${commit}${dirty ? ', TREE DIRTY' : ''})`)
console.log(`  artifact  ${cfg.format.toUpperCase()}, ${kb(bytes)}  ->  src/assets/${file}`)
if (combinedUf2) {
  console.log(
    `  fs        ${combinedUf2.blockCount} × ${combinedUf2.blockSize} B @ 0x${combinedUf2.fsBase.toString(16)}  (family 0x${combinedUf2.family.toString(16)})`,
  )
}
console.log(`  meta      src/export/firmwareRelease.generated.ts  (+ .json store)`)
if (dirty) console.log(`\n  WARNING: ${target} firmware tree is dirty — this artifact may not match commit ${commit}.`)
console.log('\nReview the diff, then commit the artifact + generated files to ship it.')
