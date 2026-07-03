import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { DEVICES, checkLimits } from '../export/devices'
import { encodeRaster, estimateBytes } from '../export/format'
import { rp2040MainPy, rp2040Readme } from '../export/rp2040'
import { serializeProjectFile } from '../export/projectFile'
import { downloadBytes, zipProject } from '../export/download'

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

// Pico W (MicroPython v1.28.0) LittleFS: 212 blocks × 4096 B — shown as the
// filesystem capacity next to the data size on the UF2 target.
const PICO_W_FS_BYTES = 212 * 4096

/** Export modal: pick a target device, see size/limits, download program + data. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const raster = useStore((s) => s.raster)
  const getProjectFile = useStore((s) => s.getProjectFile)
  const [deviceId, setDeviceId] = useState('rp2040')
  const [pin, setPin] = useState(0)
  const [brightness, setBrightness] = useState(1)
  const [building, setBuilding] = useState(false)

  const device = DEVICES.find((d) => d.id === deviceId)!
  const bytes = estimateBytes(raster)
  const warnings = checkLimits(device, raster, bytes)
  const duration = raster.numFrames / raster.fps
  const hasRp2040 = device.targets.includes('rp2040-micropython')

  const exportProject = () => {
    const data = encodeRaster(raster)
    const zip = zipProject({
      'main.py': rp2040MainPy(pin, Number(brightness.toFixed(2))),
      'pattern.bin': data,
      'project.json': serializeProjectFile(getProjectFile()),
      'README.txt': rp2040Readme(pin),
    })
    downloadBytes('led-animation-rp2040.zip', zip, 'application/zip')
  }
  const exportData = () => downloadBytes('pattern.bin', encodeRaster(raster), 'application/octet-stream')
  const exportUf2 = async () => {
    setBuilding(true)
    try {
      // Lazy-load: pulls in the littlefs wasm + firmware only when used.
      const { buildRp2040CombinedUf2 } = await import('../export/combinedUf2')
      const uf2 = await buildRp2040CombinedUf2(raster, pin, Number(brightness.toFixed(2)))
      downloadBytes('led-animation-picow.uf2', uf2, 'application/octet-stream')
    } catch (e) {
      window.alert(`Could not build the UF2: ${(e as Error).message}`)
    } finally {
      setBuilding(false)
    }
  }

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
              <span>Data pin (GP)</span>
              <input type="number" min={0} max={29} value={pin} onChange={(e) => setPin(Number(e.target.value))} />
            </label>
            <label className="field-row">
              <span>Brightness</span>
              <input type="range" min={0} max={1} step={0.05} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
              <span className="muted">{Math.round(brightness * 100)}%</span>
            </label>
            <div className="export-actions">
              <button className="btn btn-primary" disabled={building} onClick={exportUf2}>
                {building ? 'Building UF2…' : 'One-drag UF2 (blank Pico W)'}
              </button>
              <InfoDot label="One-drag UF2 details">
                Drop it onto the RPI-RP2 drive of a blank Pico W — nothing to install first.
                A single gapless firmware image (~4&nbsp;MB) containing:
                <ul>
                  <li>MicroPython <strong>v1.28.0</strong> (pinned) for the Pico W</li>
                  <li>a LittleFS filesystem with <code>main.py</code> (the player) + <code>pattern.bin</code> (your animation)</li>
                </ul>
                The firmware→filesystem gap is filled so macOS drag-and-drop copies the whole
                thing. If the strip stays dark after flashing, flash the same file with{' '}
                <code>picotool load led-animation-picow.uf2</code> instead.
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
              </InfoDot>
            </div>
            <div className="export-actions">
              <button className="btn" onClick={exportProject}>MicroPython project (.zip)</button>
              <InfoDot label="MicroPython project (.zip) details">
                For a Pico that already runs MicroPython. Contains <code>main.py</code>,{' '}
                <code>pattern.bin</code>, <code>project.json</code>, and a README. Copy it to the
                board with <code>mpremote</code> or Thonny — it doesn't touch the firmware.
              </InfoDot>
              <button className="btn" onClick={exportData}>Pattern data only (.bin)</button>
              <InfoDot label="Pattern data (.bin) details">
                Just the raw <code>pattern.bin</code>, to drop next to an existing <code>main.py</code>{' '}
                on a Pico that already runs MicroPython. Copy it over with <code>mpremote</code> or Thonny.
              </InfoDot>
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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    const close = () => setPos(null)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggle = () => {
    if (open) return setPos(null)
    const r = btnRef.current!.getBoundingClientRect()
    const half = 137 // half the popover width (270) + a hair
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    setPos({ left, top: r.top - 8 })
  }

  return (
    <span className="info">
      <button type="button" className="info-dot" aria-label={label} aria-expanded={open} onClick={toggle}>
        i
      </button>
      {open &&
        createPortal(
          <div ref={popRef} className="info-pop" role="tooltip" style={{ left: pos.left, top: pos.top }}>
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
