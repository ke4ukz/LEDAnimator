import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { InfoDot } from './InfoDot'
import { partitionByDevice } from '../bake'
import { DEVICES, checkLimits } from '../export/devices'
import type { Uf2Target } from '../export/combinedUf2'
import { encodeRasterAs, estimateBytesFor, rgb565Error, PIXEL_FORMAT, ROLE, LOSS, STARTUP, type LedaMeta } from '../export/format'
import { buildIndexed, countDistinctColors, type IndexedResult } from '../export/palette'
import { downloadBytes, zipProject } from '../export/download'
import { FIRMWARE_RELEASES } from '../export/firmwareRelease.generated'

type ExportFormat = 'uf2' | 'leda'
type ColorFormat = 'rgb888' | 'rgb565' | 'indexed'

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

/** A filesystem-safe base name from the project title (no extension). */
const sanitizeName = (name: string) => name.trim().replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'pattern'
/** Zero-padded program-number filename prefix, e.g. 7 → "07-". */
const progPrefix = (program: number) => `${String(program).padStart(2, '0')}-`

// The pinned Rust firmware's LittleFS capacity (from the release metadata) — shown
// as the filesystem size next to the pattern's data size on the UF2 target.
const RP2040_FS_BYTES = (FIRMWARE_RELEASES.rp2040.combinedUf2?.blockCount ?? 0) * (FIRMWARE_RELEASES.rp2040.combinedUf2?.blockSize ?? 0)

/** Export modal: pick a target, set the program number + per-device settings,
 *  download one bundle per format (per-device slices from `partitionByDevice`). */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const raster = useStore((s) => s.raster)
  const leds = useStore((s) => s.leds)
  // One export stream per device id (unassigned LEDs dropped, chain order kept).
  const devices = useMemo(() => partitionByDevice(raster, leds), [raster, leds])
  const projectName = useStore((s) => s.projectName)
  const program = useStore((s) => s.program)
  const setProgram = useStore((s) => s.setProgram)
  const deviceSettings = useStore((s) => s.deviceSettings)
  const setDeviceSettings = useStore((s) => s.setDeviceSettings)
  const deviceDefaults = useStore((s) => s.deviceDefaults)
  const setDeviceDefaults = useStore((s) => s.setDeviceDefaults)
  const multiDevice = useStore((s) => s.multiDevice)
  const setMultiDevice = useStore((s) => s.setMultiDevice)

  // Remember the last target platform + format across sessions.
  const [deviceId, setDeviceId] = useState(() => {
    const saved = localStorage.getItem('leda.export.device')
    return DEVICES.some((d) => d.id === saved) ? saved! : 'rp2040'
  })
  const [format, setFormat] = useState<ExportFormat>(() => {
    const saved = localStorage.getItem('leda.export.format')
    return saved === 'uf2' || saved === 'leda' ? saved : 'uf2'
  })
  const [colorFormat, setColorFormat] = useState<ColorFormat>(() => {
    const saved = localStorage.getItem('leda.export.color')
    return saved === 'rgb888' || saved === 'rgb565' || saved === 'indexed' ? saved : 'rgb888'
  })
  useEffect(() => { localStorage.setItem('leda.export.device', deviceId) }, [deviceId])
  useEffect(() => { localStorage.setItem('leda.export.format', format) }, [format])
  useEffect(() => { localStorage.setItem('leda.export.color', colorFormat) }, [colorFormat])
  const [building, setBuilding] = useState(false)

  const formatByte = PIXEL_FORMAT[colorFormat]
  // Indexed color: quantize each device's slice to its own palette (per-device, so a
  // device only carries the colors it shows). Built only when indexed is picked, and
  // memoized — median-cut over a whole raster isn't free. `exact` is false when a
  // slice had > 256 colors and had to be approximated.
  const indexedByDevice = useMemo(() => {
    if (colorFormat !== 'indexed') return null
    const m = new Map<number, IndexedResult>()
    for (const { device, raster } of devices) m.set(device, buildIndexed(raster.data))
    return m
  }, [devices, colorFormat])
  const quantized = indexedByDevice ? [...indexedByDevice.values()].some((r) => !r.exact) : false
  const maxDistinct = indexedByDevice ? Math.max(...[...indexedByDevice.values()].map((r) => r.distinct)) : 0

  // Distinct colors across the whole animation (capped so a huge raster can't
  // stall the dialog) + the measured RGB565 shift, for the color trade-off readout.
  const DISTINCT_CAP = 200_000
  const distinctColors = useMemo(() => countDistinctColors(raster.data, DISTINCT_CAP), [raster])
  const rgb565Err = useMemo(
    () => (colorFormat === 'rgb565' ? rgb565Error(raster.data) : null),
    [raster, colorFormat],
  )
  const distinctLabel = distinctColors > DISTINCT_CAP ? `${(DISTINCT_CAP / 1000) | 0}k+` : distinctColors.toLocaleString()

  const multi = devices.length > 1
  const deviceIds = devices.map((d) => d.device)
  // The leader is one of the exported devices (leader + controller); if the saved
  // choice isn't present (e.g. it got disabled), fall back to the lowest device.
  const effectiveLeader = multi ? (deviceIds.includes(multiDevice.leader) ? multiDevice.leader : deviceIds[0]) : -1
  // Sync metadata stamped into each device's .leda header. Single-device → a plain
  // standalone; multi → the leader is leader+controller, everyone else a follower.
  const metaFor = (device: number): LedaMeta => {
    if (!multi) return { role: ROLE.standalone, device }
    const common = { group: multiDevice.group, device, lossPolicy: multiDevice.lossPolicy, startup: multiDevice.startup }
    // Auto-elect: every device is role=auto (first to boot leads). Fixed: the
    // chosen device is leader+controller, the rest are followers.
    if (multiDevice.autoElect) return { role: ROLE.auto, ...common }
    return { role: device === effectiveLeader ? ROLE.leader : ROLE.follower, ...common }
  }
  const base = sanitizeName(projectName)
  const progNum = String(program).padStart(2, '0')
  const progBase = `${progPrefix(program)}${base}` // e.g. 07-aurora
  // The pattern filename handed to one device; distinct per device when split so
  // the downloaded slices are tellable apart (the firmware keys on the "07-" prefix).
  const ledaName = (device: number) => (multi ? `${progBase}-dev${device}.leda` : `${progBase}.leda`)

  // "Set all devices at once" only applies when there's more than one device.
  const uniform = multi && deviceDefaults.uniform

  // Per-device firmware settings. Brightness comes from the shared default when
  // uniform, else per device; the name is always per device. (The data pin is fixed
  // at GP0 in the firmware, so it isn't a setting.)
  const defaultName = (projectName.trim() || 'LED Animator').slice(0, 26)
  const settingsFor = (device: number) => {
    const s = deviceSettings[device] ?? {}
    return {
      name: (s.name ?? '').trim() || defaultName,
      brightness: uniform ? deviceDefaults.brightness : s.brightness ?? 1,
    }
  }

  // Name/brightness are baked into the UF2's filesystem — they don't apply to a raw .leda.
  const needsSettings = format === 'uf2'

  const platform = DEVICES.find((d) => d.id === deviceId)!
  // Combined-UF2 targets (firmware + baked pattern): rp2040 / rp2350. Both ship a
  // one-drag UF2; other devices are export-planned only.
  const uf2Target: Uf2Target | null = deviceId === 'rp2040' || deviceId === 'rp2350' ? deviceId : null
  const hasUf2 = uf2Target !== null

  const perDevice = devices.map(({ device, raster }) => {
    const bytes = estimateBytesFor(raster, formatByte, indexedByDevice?.get(device)?.count ?? 256)
    return { device, bytes, warnings: checkLimits(platform, raster, bytes) }
  })
  const bytesByDevice = new Map(perDevice.map((d) => [d.device, d.bytes]))
  const totalLeds = devices.reduce((s, d) => s + d.raster.numLeds, 0)
  const maxBytes = perDevice.reduce((m, d) => Math.max(m, d.bytes), 0)
  // Each board holds its own slice, so limits apply per device; prefix multi-device
  // warnings with the device id.
  const warnings = perDevice.flatMap((d) => d.warnings.map((w) => (multi ? `Device ${d.device}: ${w}` : w)))
  const duration = raster.numFrames / raster.fps

  // Root-level manifest for a multi-device bundle: which file/folder is whose.
  const buildManifest = (targetFor: (device: number) => string, targetHead: string, targetWord: string): string => {
    const rows = devices.map(({ device, raster }) => ({
      num: String(device),
      name: settingsFor(device).name,
      target: targetFor(device),
      leds: String(raster.numLeds),
      size: fmtBytes(bytesByDevice.get(device) ?? 0),
    }))
    const head = { num: '#', name: 'Device name', target: targetHead, leds: 'LEDs', size: 'Size' }
    const width = (k: 'num' | 'name' | 'target' | 'leds') => Math.max(head[k].length, ...rows.map((r) => r[k].length))
    const wNum = width('num'), wName = width('name'), wTarget = width('target'), wLeds = width('leds')
    const line = (num: string, name: string, target: string, leds: string, size: string) =>
      `  ${num.padEnd(wNum)}  ${name.padEnd(wName)}  ${target.padEnd(wTarget)}  ${leds.padStart(wLeds)}  ${size}`
    return [
      'LED Animator - multi-device export',
      `Program ${progNum} "${projectName.trim() || 'Untitled'}" - ${raster.numFrames} frames @ ${raster.fps} fps, ${devices.length} devices`,
      '',
      `Give each device its own ${targetWord} below, matched by device number:`,
      '',
      line(head.num, head.name, head.target, head.leds, head.size),
      ...rows.map((r) => line(r.num, r.name, r.target, r.leds, r.size)),
      '',
    ].join('\n')
  }

  // Encode one device's slice in the chosen color format (reusing its prebuilt
  // indexed palette when indexed is selected).
  const encodeFor = (device: number, r: typeof raster) =>
    encodeRasterAs(r, formatByte, metaFor(device), indexedByDevice?.get(device))

  const exportLeda = () => {
    if (!multi) {
      downloadBytes(ledaName(devices[0].device), encodeFor(devices[0].device, devices[0].raster), 'application/octet-stream')
      return
    }
    const files: Record<string, string | Uint8Array> = {}
    for (const { device, raster } of devices) files[ledaName(device)] = encodeFor(device, raster)
    files['manifest.txt'] = buildManifest(ledaName, 'File', 'file')
    downloadBytes(`${progBase}.zip`, zipProject(files), 'application/zip')
  }

  const exportUf2 = async () => {
    if (!uf2Target) return
    setBuilding(true)
    try {
      // Lazy-load: pulls in the littlefs wasm + the firmware asset only when used.
      const { buildCombinedUf2 } = await import('../export/combinedUf2')
      const buildOne = (device: number, r: typeof raster) => {
        const s = settingsFor(device)
        return buildCombinedUf2(uf2Target, r, Number(s.brightness.toFixed(2)), ledaName(device), s.name, metaFor(device), encodeFor(device, r))
      }
      const tag = uf2Target === 'rp2350' ? 'pico2w' : 'picow'
      if (!multi) {
        const uf2 = await buildOne(devices[0].device, devices[0].raster)
        downloadBytes(`led-animation-${tag}.uf2`, uf2, 'application/octet-stream')
        return
      }
      const files: Record<string, string | Uint8Array> = {}
      for (const { device, raster } of devices) files[`${progBase}-dev${device}.uf2`] = await buildOne(device, raster)
      files['manifest.txt'] = buildManifest((d) => `${progBase}-dev${d}.uf2`, 'File', 'file')
      // The combined UF2 bakes in the board's firmware + needs the CYW43 radio.
      downloadBytes(`${progBase}-${tag}.zip`, zipProject(files), 'application/zip')
    } catch (e) {
      window.alert(`Could not build the UF2: ${(e as Error).message}`)
    } finally {
      setBuilding(false)
    }
  }

  const download = () => {
    // Indexed color that couldn't stay lossless: let the user stop and adjust, or
    // proceed with the best-effort approximation (their call — no palette editor).
    if (
      quantized &&
      !window.confirm(
        `This pattern uses ${maxDistinct.toLocaleString()} colors — more than a 256-color palette holds, ` +
          `so indexed color will approximate it (some banding is likely).\n\n` +
          `OK — go ahead and get as close as it can.\n` +
          `Cancel — stop so I can adjust the pattern (or pick RGB565 / RGB888).`,
      )
    ) {
      return
    }
    if (format === 'uf2') return void exportUf2()
    return exportLeda()
  }
  const downloadLabel = building
    ? 'Building UF2…'
    : format === 'uf2'
      ? multi ? `Download ${devices.length} UF2s (.zip)` : 'Download UF2'
      : multi ? `Download ${devices.length} slices (.zip)` : `Download ${ledaName(devices[0].device)}`

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Export</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        <label className="field-row">
          <span>Target platform</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {DEVICES.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>

        <label className="field-row">
          <span title="This pattern's selection id. The exported filename is prefixed with it (07-name), and a device group uses it to pick which program to play.">Program #</span>
          <input type="number" min={0} max={255} value={program} onChange={(e) => setProgram(Number(e.target.value))} />
        </label>

        <div className="export-stats">
          <Stat label="Pattern file" value={multi ? `${progBase}-dev*.leda` : ledaName(devices[0].device)} wide />
          <Stat label="Devices" value={String(devices.length)} />
          <Stat label="LEDs" value={String(totalLeds)} />
          <Stat label="Colors" value={distinctLabel} />
          <Stat label="Frames" value={String(raster.numFrames)} />
          <Stat label="Rate" value={`${raster.fps} fps`} />
          <Stat label="Loop" value={`${duration.toFixed(2)} s`} />
          <Stat
            label={multi ? 'Largest slice' : 'Data size'}
            value={hasUf2 ? `${fmtBytes(maxBytes)} / ${fmtBytes(RP2040_FS_BYTES)}` : fmtBytes(maxBytes)}
          />
        </div>

        {warnings.length > 0 && (
          <div className="warn-box">
            <strong>This project may be too large for {platform.name}:</strong>
            <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            <span className="muted">These are estimates — you can export anyway.</span>
          </div>
        )}

        {hasUf2 ? (
          <>
            <label className="field-row">
              <span>Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                <option value="uf2">One-drag UF2 (firmware + pattern)</option>
                <option value="leda">Pattern data (.leda)</option>
              </select>
            </label>

            <label className="field-row">
              <span title="How each LED's color is stored. RGB888 is exact (3 bytes/LED). RGB565 halves the size with a slight color-depth loss. Indexed color is smallest for patterns with few distinct colors — it builds a palette automatically (and approximates if a slice needs more than 256 colors).">
                Color format
              </span>
              <select value={colorFormat} onChange={(e) => setColorFormat(e.target.value as ColorFormat)}>
                <option value="rgb888">RGB888 — exact (3 B/LED)</option>
                <option value="rgb565">RGB565 — smaller (2 B/LED)</option>
                <option value="indexed">Indexed — palette (1 B/LED)</option>
              </select>
            </label>

            <p className="muted color-note">
              {colorFormat === 'rgb888' &&
                `Every one of this pattern's ${distinctLabel} colors is kept exactly — no loss.`}
              {colorFormat === 'rgb565' &&
                rgb565Err &&
                `65k-color depth: channels shift ~${rgb565Err.avg.toFixed(1)} avg, ${rgb565Err.max} max (of 255). ` +
                  (rgb565Err.max <= 2
                    ? 'Effectively invisible here.'
                    : rgb565Err.max <= 6
                      ? 'Subtle — mostly on smooth fades.'
                      : 'Watch smooth gradients for slight banding.')}
              {colorFormat === 'indexed' &&
                !quantized &&
                `Lossless: a ${maxDistinct.toLocaleString()}-color palette${multi ? ' per device' : ''} covers this pattern exactly.`}
              {colorFormat === 'indexed' &&
                quantized &&
                `This pattern's ${distinctLabel} colors exceed a 256-color palette (see below).`}
            </p>

            {quantized && (
              <div className="warn-box">
                <strong>Indexed color will approximate this pattern.</strong>
                <span className="muted">
                  {' '}
                  {multi ? 'A device slice has' : 'It has'} {maxDistinct.toLocaleString()} distinct colors, more than a
                  256-color palette holds. Export gets as close as it can (expect some banding), or switch to RGB565 /
                  RGB888 to keep it exact.
                </span>
              </div>
            )}

            {multi && (
              <fieldset className="device-block">
                <legend>Multi-device sync</legend>
                <label className="field-row">
                  <span title="This installation's sync group id (0-255), stamped into every device here. Followers only lock to a leader broadcasting this same group.">Group ID</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={multiDevice.group}
                    onChange={(e) => setMultiDevice({ group: Math.max(0, Math.min(255, Math.floor(Number(e.target.value)) || 0)) })}
                  />
                </label>
                <label className="field-row">
                  <span title="Which device runs the master clock + beacon. Fixed: you pick it (it still drives its own strip); the rest follow. Auto: the first device to power on elects itself leader — flexible when physical position doesn't dictate who must lead.">Leader</span>
                  <select
                    value={multiDevice.autoElect ? -1 : effectiveLeader}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (v === -1) setMultiDevice({ autoElect: true })
                      else setMultiDevice({ autoElect: false, leader: v })
                    }}
                  >
                    {devices.map(({ device }) => (
                      <option key={device} value={device}>Fixed · Device {device} — {settingsFor(device).name}</option>
                    ))}
                    <option value={-1}>Auto · first to boot</option>
                  </select>
                </label>
                <label className="field-row">
                  <span title="How a follower behaves before its first sync. Wait-for-sync holds dark until it hears the leader (clean for a display). Start-and-go plays its own animation right away and snaps into sync when a leader appears (a lamp that works alone but syncs with company).">Follower startup</span>
                  <select value={multiDevice.startup} onChange={(e) => setMultiDevice({ startup: Number(e.target.value) })}>
                    <option value={STARTUP.wait}>Wait for sync</option>
                    <option value={STARTUP.go}>Start-and-go</option>
                  </select>
                </label>
                <label className="field-row">
                  <span title="What a follower does if it loses the leader's beacon. Either way it keeps its own clock running and re-locks the instant the leader returns.">On sync loss</span>
                  <select value={multiDevice.lossPolicy} onChange={(e) => setMultiDevice({ lossPolicy: Number(e.target.value) })}>
                    <option value={LOSS.indicate}>Keep playing · amber LED 0</option>
                    <option value={LOSS.silent}>Keep playing · silent</option>
                    <option value={LOSS.blackout}>Blackout until leader returns</option>
                  </select>
                </label>
              </fieldset>
            )}

            {needsSettings && (
              <div className="device-settings">
                {multi && (
                  <label className="field-row">
                    <span title="Bake the same data pin and brightness into every device. Turn off to set them per device.">
                      Same pin &amp; brightness for all
                    </span>
                    <input
                      type="checkbox"
                      checked={deviceDefaults.uniform}
                      onChange={(e) => setDeviceDefaults({ uniform: e.target.checked })}
                    />
                  </label>
                )}

                {uniform && (
                  <fieldset className="device-block">
                    <legend>All devices</legend>
                    <label className="field-row">
                      <span>Brightness</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={deviceDefaults.brightness}
                        onChange={(e) => setDeviceDefaults({ brightness: Number(e.target.value) })}
                      />
                      <span className="muted">{Math.round(deviceDefaults.brightness * 100)}%</span>
                    </label>
                  </fieldset>
                )}

                {devices.map(({ device, raster }) => {
                  const s = settingsFor(device)
                  return (
                    <fieldset className="device-block" key={device}>
                      <legend>
                        {multi ? `Device ${device}` : 'Device'} · {raster.numLeds} LED{raster.numLeds === 1 ? '' : 's'}
                        {multi && !uniform && ` · ${fmtBytes(bytesByDevice.get(device) ?? 0)}`}
                      </legend>
                      <label className="field-row">
                        <span>Device name</span>
                        <input
                          type="text"
                          maxLength={26}
                          value={s.name}
                          placeholder="LED Animator"
                          onChange={(e) => setDeviceSettings(device, { name: e.target.value })}
                        />
                      </label>
                      {!uniform && (
                        <label className="field-row">
                          <span>Brightness</span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={s.brightness}
                            onChange={(e) => setDeviceSettings(device, { brightness: Number(e.target.value) })}
                          />
                          <span className="muted">{Math.round(s.brightness * 100)}%</span>
                        </label>
                      )}
                    </fieldset>
                  )
                })}
              </div>
            )}

            <div className="export-actions">
              <button className="btn btn-primary" disabled={building} onClick={download}>
                {downloadLabel}
              </button>
              <InfoDot label="Export format details">{formatInfo(format, multi, uf2Target)}</InfoDot>
            </div>
          </>
        ) : (
          <p className="placeholder">Export for {platform.name} is planned — the size and limits above already apply.</p>
        )}
      </div>
    </div>
  )
}

/** The details popover content for the selected export format. */
function formatInfo(format: ExportFormat, multi: boolean, uf2Target: Uf2Target | null): ReactNode {
  const multiNote = (unit: string) => (
    <p className="hint-link">
      This project spans multiple devices, so the download is a <strong>.zip</strong> with one {unit} per
      device (each device plays its own slice of the same program). Give each device its file.
    </p>
  )
  if (format === 'uf2') {
    // Bootloader drive + board name differ by chip (Pico W = RPI-RP2, Pico 2 W = RP2350).
    const drive = uf2Target === 'rp2350' ? 'RP2350' : 'RPI-RP2'
    const board = uf2Target === 'rp2350' ? 'Pico 2 W' : 'Pico W'
    const tag = uf2Target === 'rp2350' ? 'pico2w' : 'picow'
    return (
      <>
        Drop it onto the {drive} drive of a blank {board} — nothing to install first. A single gapless
        firmware image (~4&nbsp;MB) with the <strong>LED Animator firmware</strong> plus a filesystem
        holding your pattern, brightness, and device name. The strip's data line goes to <strong>GP0</strong>.
        If the strip stays dark after flashing, flash the same file with{' '}
        <code>picotool load led-animation-{tag}.uf2</code> instead.
        {multi && multiNote('.uf2')}
        <p className="hint-link">
          To enter bootloader mode, hold <strong>BOOTSEL</strong> while plugging in —{' '}
          <a
            href="https://www.raspberrypi.com/documentation/microcontrollers/micropython.html#drag-and-drop-micropython"
            target="_blank"
            rel="noopener noreferrer"
          >
            Raspberry Pi's guide
          </a>
          . (Don't download their UF2; use the button above.)
        </p>
      </>
    )
  }
  return (
    <>
      Just the raw pattern file, named after your project (prefixed with the program number). Upload it to a
      device already running LED Animator from the companion app, then it becomes selectable.
      {multi && multiNote('.leda')}
    </>
  )
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'stat stat-wide' : 'stat'}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
