import type { ReactNode } from 'react'
import { useStore } from '../store'
import { hexToRgb, type InterpSpace, rgbToHex } from '../color'
import {
  type DualCombine,
  type Gradient,
  type GradientStop,
  type RadialMetric,
  makeStop,
} from '../gradient'
import { PRESETS, instantiateGradient } from '../presets'
import { GradientPreview } from './GradientPreview'
import { PathOverlay } from './PathOverlay'
import { RampEditor } from './RampEditor'

const DEG = 180 / Math.PI
const TYPES: { value: Gradient['type']; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'conic', label: 'Conic' },
  { value: 'dualRadial', label: 'Dual radial' },
  { value: 'noise', label: 'Noise / flicker' },
  { value: 'bilinear', label: 'Bilinear (corners)' },
]

const DEFAULT_STOPS = (): GradientStop[] => [
  makeStop(0, [255, 255, 255]),
  makeStop(1, [20, 30, 90]),
]

/** Build a gradient of `type`, carrying over stops/interp where it makes sense. */
function withType(g: Gradient, type: Gradient['type']): Gradient {
  if (g.type === type) return g
  const interp: InterpSpace = g.interp
  const stops = 'stops' in g ? g.stops : DEFAULT_STOPS()
  switch (type) {
    case 'linear': return { type, angle: 0, interp, stops }
    case 'radial': return { type, cx: 0.5, cy: 0.5, radius: 0.5, metric: 'euclidean', interp, stops }
    case 'conic': return { type, cx: 0.5, cy: 0.5, angle: 0, interp, stops }
    case 'dualRadial':
      return { type, c1x: 0.25, c1y: 0.5, c2x: 0.75, c2y: 0.5, radius: 0.5, combine: 'nearest', interp, stops }
    case 'noise':
      return { type, scale: 12, octaves: 3, seed: 1337, interp, stops }
    case 'bilinear':
      return { type, interp, tl: [230, 40, 90], tr: [250, 210, 40], bl: [40, 90, 230], br: [40, 220, 140] }
  }
}

export function GradientEditor() {
  const project = useStore((s) => s.project)
  const selectedTrack = useStore((s) => s.selectedTrack)
  const setGradient = useStore((s) => s.updateGradient)

  const track = project.tracks.find((t) => t.id === selectedTrack)
  const source = project.sources.find((s) => s.id === track?.sourceId)
  const gradient = source?.gradient

  if (!track || !gradient) return <p className="placeholder">Select a track to edit its source.</p>

  // Spread-and-cast patch: the discriminated union keeps the active variant.
  const patch = (p: Partial<Gradient>) => setGradient({ ...gradient, ...p } as Gradient)

  return (
    <div className="grad-editor">
      <div className="preview-wrap">
        <GradientPreview gradient={gradient} />
        <PathOverlay track={track} />
      </div>
      <span className="muted preview-hint">Drag the handles to edit this track's sampling path.</span>

      <Row label="Preset">
        <select
          defaultValue=""
          onChange={(e) => {
            const preset = PRESETS[Number(e.target.value)]
            if (preset) setGradient(instantiateGradient(preset.gradient))
            e.target.value = ''
          }}
        >
          <option value="" disabled>Load…</option>
          {PRESETS.map((p, i) => (
            <option key={p.name} value={i}>{p.name}</option>
          ))}
        </select>
      </Row>

      <Row label="Type">
        <select value={gradient.type} onChange={(e) => setGradient(withType(gradient, e.target.value as Gradient['type']))}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </Row>

      <Row label="Interp">
        <select value={gradient.interp} onChange={(e) => patch({ interp: e.target.value as InterpSpace })}>
          <option value="rgb">RGB</option>
          <option value="hsl">HSL (hue)</option>
          <option value="oklch">OKLCH</option>
        </select>
      </Row>

      {gradient.type === 'linear' && (
        <Angle label="Angle" rad={gradient.angle} onChange={(angle) => patch({ angle })} />
      )}

      {gradient.type === 'radial' && (
        <>
          <Num label="Center X" value={gradient.cx} onChange={(cx) => patch({ cx })} />
          <Num label="Center Y" value={gradient.cy} onChange={(cy) => patch({ cy })} />
          <Num label="Radius" value={gradient.radius} onChange={(radius) => patch({ radius })} />
          <Row label="Shape">
            <select value={gradient.metric} onChange={(e) => patch({ metric: e.target.value as RadialMetric })}>
              <option value="euclidean">Circle</option>
              <option value="chebyshev">Square</option>
            </select>
          </Row>
        </>
      )}

      {gradient.type === 'conic' && (
        <>
          <Num label="Center X" value={gradient.cx} onChange={(cx) => patch({ cx })} />
          <Num label="Center Y" value={gradient.cy} onChange={(cy) => patch({ cy })} />
          <Angle label="Angle" rad={gradient.angle} onChange={(angle) => patch({ angle })} />
        </>
      )}

      {gradient.type === 'dualRadial' && (
        <>
          <Num label="Center 1 X" value={gradient.c1x} onChange={(c1x) => patch({ c1x })} />
          <Num label="Center 1 Y" value={gradient.c1y} onChange={(c1y) => patch({ c1y })} />
          <Num label="Center 2 X" value={gradient.c2x} onChange={(c2x) => patch({ c2x })} />
          <Num label="Center 2 Y" value={gradient.c2y} onChange={(c2y) => patch({ c2y })} />
          <Num label="Radius" value={gradient.radius} onChange={(radius) => patch({ radius })} />
          <Row label="Combine">
            <select value={gradient.combine} onChange={(e) => patch({ combine: e.target.value as DualCombine })}>
              <option value="nearest">Nearest (two pulses)</option>
              <option value="blend">Blend (soft basin)</option>
              <option value="difference">Difference (curved)</option>
            </select>
          </Row>
        </>
      )}

      {gradient.type === 'noise' && (
        <>
          <Row label="Scale">
            <input type="range" min={1} max={40} step={1} value={gradient.scale} onChange={(e) => patch({ scale: Number(e.target.value) })} />
            <span className="muted">{gradient.scale}</span>
          </Row>
          <Row label="Octaves">
            <input type="range" min={1} max={5} step={1} value={gradient.octaves} onChange={(e) => patch({ octaves: Number(e.target.value) })} />
            <span className="muted">{gradient.octaves}</span>
          </Row>
          <Row label="Seed">
            <span className="muted">{gradient.seed}</span>
            <button className="btn" onClick={() => patch({ seed: Math.floor(Math.random() * 1e9) })}>
              Randomize
            </button>
          </Row>
        </>
      )}

      {gradient.type === 'bilinear' ? (
        <div className="corners">
          <Corner label="TL" value={gradient.tl} onChange={(tl) => patch({ tl })} />
          <Corner label="TR" value={gradient.tr} onChange={(tr) => patch({ tr })} />
          <Corner label="BL" value={gradient.bl} onChange={(bl) => patch({ bl })} />
          <Corner label="BR" value={gradient.br} onChange={(br) => patch({ br })} />
        </div>
      ) : (
        <RampEditor stops={gradient.stops} interp={gradient.interp} onChange={(stops) => patch({ stops })} />
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  // div, not label: a label wrapping a button (e.g. Randomize) would fire that
  // button when the row text is clicked.
  return (
    <div className="field-row">
      <span>{label}</span>
      {children}
    </div>
  )
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input type="number" min={0} max={1} step={0.01} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  )
}

function Angle({ label, rad, onChange }: { label: string; rad: number; onChange: (rad: number) => void }) {
  const deg = Math.round(rad * DEG)
  return (
    <Row label={label}>
      <input type="range" min={0} max={360} step={1} value={((deg % 360) + 360) % 360} onChange={(e) => onChange(Number(e.target.value) / DEG)} />
      <span className="muted">{((deg % 360) + 360) % 360}°</span>
    </Row>
  )
}

function Corner({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (v: [number, number, number]) => void }) {
  return (
    <label className="corner">
      <span>{label}</span>
      <input type="color" value={rgbToHex(value)} onChange={(e) => onChange(hexToRgb(e.target.value))} />
    </label>
  )
}
