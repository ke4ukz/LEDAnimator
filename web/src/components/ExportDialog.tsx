import { useState } from 'react'
import { useStore } from '../store'
import { DEVICES, checkLimits } from '../export/devices'
import { encodeRaster, estimateBytes } from '../export/format'
import { rp2040MainPy, rp2040Readme } from '../export/rp2040'
import { serializeProjectFile } from '../export/projectFile'
import { downloadBytes, zipProject } from '../export/download'

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

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
        <p className="muted device-notes">{device.notes}</p>

        <div className="export-stats">
          <Stat label="LEDs" value={String(raster.numLeds)} />
          <Stat label="Frames" value={String(raster.numFrames)} />
          <Stat label="Rate" value={`${raster.fps} fps`} />
          <Stat label="Loop" value={`${duration.toFixed(2)} s`} />
          <Stat label="Data size" value={fmtBytes(bytes)} />
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
            </div>
            <p className="muted">
              Bundles MicroPython v1.28.0 + your pattern. Hold BOOTSEL, plug in the Pico W, and drop this
              onto the RPI-RP2 drive. (If it doesn't take, flash it with <code>picotool load</code>.)
            </p>
            <div className="export-actions">
              <button className="btn" onClick={exportProject}>MicroPython project (.zip)</button>
              <button className="btn" onClick={exportData}>Pattern data only (.bin)</button>
            </div>
            <p className="muted">The .zip / .bin need MicroPython already installed (copy via mpremote/Thonny).</p>
          </>
        ) : (
          <p className="placeholder">Export for {device.name} is planned — the size and limits above already apply.</p>
        )}
      </div>
    </div>
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
