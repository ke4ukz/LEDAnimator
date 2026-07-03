import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { DEVICES, checkLimits } from '../export/devices'
import { encodeRaster, estimateBytes } from '../export/format'
import { rp2040MainPy, rp2040Readme, rp2040SettingsFiles } from '../export/rp2040'
import { serializeProjectFile } from '../export/projectFile'
import { downloadBytes, zipProject } from '../export/download'
import { commit } from 'virtual:build-info'

type ExportFormat = 'uf2' | 'zip' | 'leda'

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

/** A filesystem-safe <name>.leda from the project title. */
const ledaFilename = (name: string) => `${name.trim().replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'pattern'}.leda`

// Firmware build identifier baked into main.py (no real release yet) — the app
// build's commit, so a device reports which build produced its firmware.
const FW_BUILD = `dev+${commit}`

// Pico W (MicroPython v1.28.0) LittleFS: 212 blocks × 4096 B — shown as the
// filesystem capacity next to the data size on the UF2 target.
const PICO_W_FS_BYTES = 212 * 4096

/** Export modal: pick a target device, see size/limits, download program + data. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const raster = useStore((s) => s.raster)
  const getProjectFile = useStore((s) => s.getProjectFile)
  const [deviceId, setDeviceId] = useState('rp2040')
  const [format, setFormat] = useState<ExportFormat>('uf2')
  const [pin, setPin] = useState(0)
  const [brightness, setBrightness] = useState(1)
  const [deviceName, setDeviceName] = useState('LED Animator')
  const [building, setBuilding] = useState(false)
  const projectName = useStore((s) => s.projectName)

  const bleName = deviceName.trim() || 'LED Animator'
  // Name/pin/brightness are written as device settings — they don't apply to a raw .leda.
  const needsSettings = format === 'uf2' || format === 'zip'

  const device = DEVICES.find((d) => d.id === deviceId)!
  const bytes = estimateBytes(raster)
  const warnings = checkLimits(device, raster, bytes)
  const duration = raster.numFrames / raster.fps
  const hasRp2040 = device.targets.includes('rp2040-micropython')

  const exportProject = () => {
    const patternFile = ledaFilename(projectName)
    const zip = zipProject({
      'main.py': rp2040MainPy(FW_BUILD),
      [patternFile]: encodeRaster(raster),
      ...rp2040SettingsFiles(pin, Number(brightness.toFixed(2)), bleName, patternFile),
      'project.json': serializeProjectFile(getProjectFile()),
      'README.txt': rp2040Readme(pin, patternFile),
    })
    downloadBytes('led-animation-rp2040.zip', zip, 'application/zip')
  }
  const exportData = () => downloadBytes(ledaFilename(projectName), encodeRaster(raster), 'application/octet-stream')
  const exportUf2 = async () => {
    setBuilding(true)
    try {
      // Lazy-load: pulls in the littlefs wasm + firmware only when used.
      const { buildRp2040CombinedUf2 } = await import('../export/combinedUf2')
      const uf2 = await buildRp2040CombinedUf2(raster, pin, Number(brightness.toFixed(2)), ledaFilename(projectName), bleName, FW_BUILD)
      downloadBytes('led-animation-picow.uf2', uf2, 'application/octet-stream')
    } catch (e) {
      window.alert(`Could not build the UF2: ${(e as Error).message}`)
    } finally {
      setBuilding(false)
    }
  }

  const download = () => {
    if (format === 'uf2') return void exportUf2()
    if (format === 'zip') return exportProject()
    return exportData()
  }
  const downloadLabel = building
    ? 'Building UF2…'
    : format === 'uf2'
      ? 'Download UF2'
      : format === 'zip'
        ? 'Download .zip'
        : `Download ${ledaFilename(projectName)}`

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Export</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        <label className="field-row">
          <span>Target device</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {DEVICES.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>

        <div className="export-stats">
          <Stat label="Filename" value={ledaFilename(projectName)} wide />
          <Stat label="LEDs" value={String(raster.numLeds)} />
          <Stat label="Frames" value={String(raster.numFrames)} />
          <Stat label="Rate" value={`${raster.fps} fps`} />
          <Stat label="Loop" value={`${duration.toFixed(2)} s`} />
          <Stat
            label="Data size"
            value={hasRp2040 ? `${fmtBytes(bytes)} / ${fmtBytes(PICO_W_FS_BYTES)}` : fmtBytes(bytes)}
          />
        </div>

        {warnings.length > 0 && (
          <div className="warn-box">
            <strong>This project may be too large for {device.name}:</strong>
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
              <>
                <label className="field-row">
                  <span>Device name</span>
                  <input
                    type="text"
                    maxLength={26}
                    value={deviceName}
                    placeholder="LED Animator"
                    onChange={(e) => setDeviceName(e.target.value)}
                  />
                </label>
                <label className="field-row">
                  <span>Data pin (GP)</span>
                  <input type="number" min={0} max={29} value={pin} onChange={(e) => setPin(Number(e.target.value))} />
                </label>
                <label className="field-row">
                  <span>Brightness</span>
                  <input type="range" min={0} max={1} step={0.05} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
                  <span className="muted">{Math.round(brightness * 100)}%</span>
                </label>
              </>
            )}

            <div className="export-actions">
              <button className="btn btn-primary" disabled={building} onClick={download}>
                {downloadLabel}
              </button>
              <InfoDot label="Export format details">{formatInfo(format)}</InfoDot>
            </div>
          </>
        ) : (
          <p className="placeholder">Export for {device.name} is planned — the size and limits above already apply.</p>
        )}
      </div>
    </div>
  )
}

/**
 * Inline "ⓘ" that reveals a details popover on click. The popover is portaled
 * to <body> with fixed positioning so it isn't clipped by the modal's overflow.
 * Closes on outside-click, Escape, or scroll/resize.
 */
function InfoDot({ label, children }: { label: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    const close = () => setPos(null)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    // Defer a frame so the click that opened us can't immediately close us.
    const id = requestAnimationFrame(() => {
      window.addEventListener('pointerdown', onDown)
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', close)
    })
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggle = () => {
    if (open) return setPos(null)
    const r = btnRef.current!.getBoundingClientRect()
    const half = 137 // half the popover width (270) + a hair
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    // Open above the button, unless it sits in the top half — then drop below,
    // so a tall popover can't run off the top of the screen.
    const above = r.top > window.innerHeight * 0.5
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above })
  }

  return (
    <span className="info">
      <button ref={btnRef} type="button" className="info-dot" aria-label={label} aria-expanded={open} onClick={toggle}>
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="info-pop"
            role="tooltip"
            style={{ left: pos.left, top: pos.top, transform: `translate(-50%, ${pos.above ? '-100%' : '0'})` }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** The details popover content for the selected export format. */
function formatInfo(format: ExportFormat): ReactNode {
  if (format === 'uf2') {
    return (
      <>
        Drop it onto the RPI-RP2 drive of a blank Pico W — nothing to install first. A single gapless
        firmware image (~4&nbsp;MB) with MicroPython <strong>v1.28.0</strong> plus a filesystem holding
        the player, your pattern, and the device settings (pin / brightness / name). If the strip stays
        dark after flashing, flash the same file with <code>picotool load led-animation-picow.uf2</code>{' '}
        instead.
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
      </>
    )
  }
  return (
    <>
      Just the raw pattern file, named after your project. Drop it next to an existing <code>main.py</code>{' '}
      on a Pico that already runs MicroPython, then <code>SELECT</code> it. Copy it over with{' '}
      <code>mpremote</code> or Thonny.
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
