import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { InfoDot } from './InfoDot'
import { partitionByDevice } from '../bake'
import { DEVICES, checkLimits } from '../export/devices'
import { encodeRaster, estimateBytes } from '../export/format'
import { rp2040MainPy, rp2040Readme, rp2040SettingsFiles } from '../export/rp2040'
import { serializeProjectFile } from '../export/projectFile'
import { downloadBytes, zipProject } from '../export/download'
import { commit } from 'virtual:build-info'

type ExportFormat = 'uf2' | 'zip' | 'leda'

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

/** A filesystem-safe base name from the project title (no extension). */
const sanitizeName = (name: string) => name.trim().replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'pattern'
/** Zero-padded program-number filename prefix, e.g. 7 → "07-". */
const progPrefix = (program: number) => `${String(program).padStart(2, '0')}-`

// Firmware build identifier baked into main.py (no real release yet) — the app
// build's commit, so a device reports which build produced its firmware.
const FW_BUILD = `dev+${commit}`

// Pico W (MicroPython v1.28.0) LittleFS: 212 blocks × 4096 B — shown as the
// filesystem capacity next to the data size on the UF2 target.
const PICO_W_FS_BYTES = 212 * 4096

/** Export modal: pick a target, set the program number + per-device settings,
 *  download one bundle per format (per-device slices from `partitionByDevice`). */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const raster = useStore((s) => s.raster)
  const leds = useStore((s) => s.leds)
  // One export stream per device id (unassigned LEDs dropped, chain order kept).
  const devices = useMemo(() => partitionByDevice(raster, leds), [raster, leds])
  const getProjectFile = useStore((s) => s.getProjectFile)
  const projectName = useStore((s) => s.projectName)
  const program = useStore((s) => s.program)
  const setProgram = useStore((s) => s.setProgram)
  const deviceSettings = useStore((s) => s.deviceSettings)
  const setDeviceSettings = useStore((s) => s.setDeviceSettings)
  const deviceDefaults = useStore((s) => s.deviceDefaults)
  const setDeviceDefaults = useStore((s) => s.setDeviceDefaults)

  // Remember the last target platform + format across sessions.
  const [deviceId, setDeviceId] = useState(() => {
    const saved = localStorage.getItem('leda.export.device')
    return DEVICES.some((d) => d.id === saved) ? saved! : 'rp2040'
  })
  const [format, setFormat] = useState<ExportFormat>(() => {
    const saved = localStorage.getItem('leda.export.format')
    return saved === 'uf2' || saved === 'zip' || saved === 'leda' ? saved : 'uf2'
  })
  useEffect(() => { localStorage.setItem('leda.export.device', deviceId) }, [deviceId])
  useEffect(() => { localStorage.setItem('leda.export.format', format) }, [format])
  const [building, setBuilding] = useState(false)

  const multi = devices.length > 1
  const base = sanitizeName(projectName)
  const progNum = String(program).padStart(2, '0')
  const progBase = `${progPrefix(program)}${base}` // e.g. 07-aurora
  // The pattern filename handed to one device; distinct per device when split so
  // the downloaded slices are tellable apart (the firmware keys on the "07-" prefix).
  const ledaName = (device: number) => (multi ? `${progBase}-dev${device}.leda` : `${progBase}.leda`)

  // "Set all devices at once" only applies when there's more than one device.
  const uniform = multi && deviceDefaults.uniform

  // Per-device firmware settings. Pin/brightness come from the shared defaults
  // when uniform, else per device; the name is always per device.
  const defaultName = (projectName.trim() || 'LED Animator').slice(0, 26)
  const settingsFor = (device: number) => {
    const s = deviceSettings[device] ?? {}
    return {
      name: (s.name ?? '').trim() || defaultName,
      pin: uniform ? deviceDefaults.pin : s.pin ?? 0,
      brightness: uniform ? deviceDefaults.brightness : s.brightness ?? 1,
    }
  }

  // Name/pin/brightness are baked as device settings — they don't apply to a raw .leda.
  const needsSettings = format === 'uf2' || format === 'zip'

  const platform = DEVICES.find((d) => d.id === deviceId)!
  const hasRp2040 = platform.targets.includes('rp2040-micropython')

  const perDevice = devices.map(({ device, raster }) => {
    const bytes = estimateBytes(raster)
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

  const exportLeda = () => {
    if (!multi) {
      downloadBytes(ledaName(devices[0].device), encodeRaster(devices[0].raster, { device: devices[0].device }), 'application/octet-stream')
      return
    }
    const files: Record<string, string | Uint8Array> = {}
    for (const { device, raster } of devices) files[ledaName(device)] = encodeRaster(raster, { device })
    files['manifest.txt'] = buildManifest(ledaName, 'File', 'file')
    downloadBytes(`${progBase}.zip`, zipProject(files), 'application/zip')
  }

  const exportZip = () => {
    const files: Record<string, string | Uint8Array> = {}
    files['project.json'] = serializeProjectFile(getProjectFile())
    for (const { device, raster } of devices) {
      const s = settingsFor(device)
      const pf = ledaName(device)
      const dir = multi ? `device-${device}/` : '' // one folder per board when split
      files[`${dir}main.py`] = rp2040MainPy(FW_BUILD)
      files[`${dir}${pf}`] = encodeRaster(raster, { device })
      for (const [n, v] of Object.entries(rp2040SettingsFiles(s.pin, Number(s.brightness.toFixed(2)), s.name, pf))) {
        files[`${dir}${n}`] = v
      }
      files[`${dir}README.txt`] = rp2040Readme(s.pin, pf)
    }
    if (multi) files['manifest.txt'] = buildManifest((d) => `device-${d}/`, 'Folder', 'folder')
    // "-rp2040" (not "-picow"): these are files for any RP2040 already running
    // MicroPython — a plain Pico plays fine; only BLE/Wi-Fi need the W. The UF2
    // is "-picow" because it bundles Pico W firmware. Intentional, not a typo.
    downloadBytes(multi ? `${progBase}-rp2040.zip` : 'led-animation-rp2040.zip', zipProject(files), 'application/zip')
  }

  const exportUf2 = async () => {
    setBuilding(true)
    try {
      // Lazy-load: pulls in the littlefs wasm + firmware only when used.
      const { buildRp2040CombinedUf2 } = await import('../export/combinedUf2')
      const buildOne = (device: number, r: typeof raster) => {
        const s = settingsFor(device)
        return buildRp2040CombinedUf2(r, s.pin, Number(s.brightness.toFixed(2)), ledaName(device), s.name, FW_BUILD)
      }
      if (!multi) {
        const uf2 = await buildOne(devices[0].device, devices[0].raster)
        downloadBytes('led-animation-picow.uf2', uf2, 'application/octet-stream')
        return
      }
      const files: Record<string, string | Uint8Array> = {}
      for (const { device, raster } of devices) files[`${progBase}-dev${device}.uf2`] = await buildOne(device, raster)
      files['manifest.txt'] = buildManifest((d) => `${progBase}-dev${d}.uf2`, 'File', 'file')
      // "-picow": the combined UF2 bakes in Pico W firmware + needs the W's radio,
      // so it's Pico-W-only (unlike the "-rp2040" MicroPython zip above).
      downloadBytes(`${progBase}-picow.zip`, zipProject(files), 'application/zip')
    } catch (e) {
      window.alert(`Could not build the UF2: ${(e as Error).message}`)
    } finally {
      setBuilding(false)
    }
  }

  const download = () => {
    if (format === 'uf2') return void exportUf2()
    if (format === 'zip') return exportZip()
    return exportLeda()
  }
  const downloadLabel = building
    ? 'Building UF2…'
    : format === 'uf2'
      ? multi ? `Download ${devices.length} UF2s (.zip)` : 'Download UF2'
      : format === 'zip'
        ? multi ? `Download ${devices.length} devices (.zip)` : 'Download .zip'
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
          <Stat label="Frames" value={String(raster.numFrames)} />
          <Stat label="Rate" value={`${raster.fps} fps`} />
          <Stat label="Loop" value={`${duration.toFixed(2)} s`} />
          <Stat
            label={multi ? 'Largest slice' : 'Data size'}
            value={hasRp2040 ? `${fmtBytes(maxBytes)} / ${fmtBytes(PICO_W_FS_BYTES)}` : fmtBytes(maxBytes)}
          />
        </div>

        {warnings.length > 0 && (
          <div className="warn-box">
            <strong>This project may be too large for {platform.name}:</strong>
            <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            <span className="muted">These are estimates — you can export anyway.</span>
          </div>
        )}

        {hasRp2040 ? (
          <>
            <label className="field-row">
              <span>Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                <option value="uf2">One-drag UF2 (blank Pico W)</option>
                <option value="zip">MicroPython files (.zip)</option>
                <option value="leda">Pattern data (.leda)</option>
              </select>
            </label>

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
                      <span>Data pin (GP)</span>
                      <input
                        type="number"
                        min={0}
                        max={29}
                        value={deviceDefaults.pin}
                        onChange={(e) => setDeviceDefaults({ pin: Number(e.target.value) })}
                      />
                    </label>
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
                        <>
                          <label className="field-row">
                            <span>Data pin (GP)</span>
                            <input
                              type="number"
                              min={0}
                              max={29}
                              value={s.pin}
                              onChange={(e) => setDeviceSettings(device, { pin: Number(e.target.value) })}
                            />
                          </label>
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
                        </>
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
              <InfoDot label="Export format details">{formatInfo(format, multi)}</InfoDot>
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
function formatInfo(format: ExportFormat, multi: boolean): ReactNode {
  const multiNote = (unit: string) => (
    <p className="hint-link">
      This project spans multiple devices, so the download is a <strong>.zip</strong> with one {unit} per
      device (each device plays its own slice of the same program). Give each device its file.
    </p>
  )
  if (format === 'uf2') {
    return (
      <>
        Drop it onto the RPI-RP2 drive of a blank Pico W — nothing to install first. A single gapless
        firmware image (~4&nbsp;MB) with MicroPython <strong>v1.28.0</strong> plus a filesystem holding
        the player, your pattern, and the device settings (pin / brightness / name). If the strip stays
        dark after flashing, flash the same file with <code>picotool load led-animation-picow.uf2</code>{' '}
        instead.
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
  if (format === 'zip') {
    return (
      <>
        For a Pico that already runs MicroPython. Contains <code>main.py</code>, your pattern (named after
        the project), the settings files (<code>datapin.txt</code>, <code>bright.txt</code>,{' '}
        <code>devicename.txt</code>, <code>selected.txt</code>), <code>project.json</code>, and a README.
        Copy them to the board with <code>mpremote</code> or Thonny — it doesn't touch the firmware.
        {multi && multiNote('device-N/ folder')}
      </>
    )
  }
  return (
    <>
      Just the raw pattern file, named after your project (prefixed with the program number). Drop it next
      to an existing <code>main.py</code> on a Pico that already runs MicroPython, then <code>SELECT</code>{' '}
      it. Copy it over with <code>mpremote</code> or Thonny.
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
