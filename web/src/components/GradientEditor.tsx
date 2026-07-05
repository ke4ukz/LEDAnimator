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
import { useRef } from 'react'
import type { PathDef } from '../project'
import { PRESETS, instantiateGradient } from '../presets'
import { TexturePreview } from './TexturePreview'
import { RampEditor } from './RampEditor'
import { GradientFocusView } from './GradientFocusView'

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

export function GradientEditor({ place = 'panel' }: { place?: 'panel' | 'focus' }) {
  const project = useStore((s) => s.project)
  const selectedTrack = useStore((s) => s.selectedTrack)
  const setGradient = useStore((s) => s.updateGradient)
  const setSourceGradient = useStore((s) => s.setSourceGradient)
  const setImageBg = useStore((s) => s.setImageBg)
  const updatePost = useStore((s) => s.updatePost)
  const updateTrack = useStore((s) => s.updateTrack)
  const focusGradient = useStore((s) => s.focusGradient)

  const track = project.tracks.find((t) => t.id === selectedTrack)
  const source = project.sources.find((s) => s.id === track?.sourceId)

  if (!track || !source) return <p className="placeholder">Select a track to edit its source.</p>

  const gradient: Gradient | null = source.kind === 'gradient' ? source.gradient : null
  const post = source.post ?? {}
  const setPath = (p: PathDef) => updateTrack(track.id, { path: p })
  // Spread-and-cast patch: the discriminated union keeps the active variant.
  const patch = (p: Partial<Gradient>) => {
    if (gradient) setGradient({ ...gradient, ...p } as Gradient)
  }

  // The two "editor" surfaces (stop ramp, or bilinear corners). In focus mode
  // these live large in the center; the normal panel then hides them so its
  // other properties stay put in their original place. An image source has
  // neither.
  const rampOrCorners = !gradient ? null : gradient.type === 'bilinear' ? (
    <div className="corners">
      <Corner label="TL" value={gradient.tl} onChange={(tl) => patch({ tl })} />
      <Corner label="TR" value={gradient.tr} onChange={(tr) => patch({ tr })} />
      <Corner label="BL" value={gradient.bl} onChange={(bl) => patch({ bl })} />
      <Corner label="BR" value={gradient.br} onChange={(br) => patch({ br })} />
    </div>
  ) : (
    <RampEditor stops={gradient.stops} interp={gradient.interp} onChange={(stops) => patch({ stops })} large={place === 'focus'} />
  )

  // Center focus surface: the large texture (with its sampling path), a
  // magnifier + color readout, and the full-width ramp — the precise bits.
  if (place === 'focus') {
    return <GradientFocusView source={source} ramp={rampOrCorners} />
  }

  // The normal panel. While focused, the texture + ramp are shown large in the
  // center instead, so omit them here (everything else stays in place).
  const focused = focusGradient
  return (
    <div className="grad-editor">
      {!focused && (
        <>
          <TexturePreview />
          <span className="muted preview-hint">Drag the handles to edit this track's sampling path.</span>
        </>
      )}

      <Row label="Path">
        <select value={track.path.type} onChange={(e) => setPath(pathOfType(e.target.value as PathDef['type']))}>
          <option value="line">Line</option>
          <option value="sine">Sine</option>
          <option value="ellipse">Ellipse</option>
          <option value="spiral">Spiral</option>
          <option value="polygon">Polygon</option>
          <option value="poly">Poly (draw)</option>
        </select>
        <button className="btn" title="Reset this path to its defaults" onClick={() => setPath(pathOfType(track.path.type))}>
          Reset
        </button>
      </Row>
      {track.path.type === 'line' && (
        <>
          <Num label="From X" value={track.path.x0} onChange={(x0) => setPath({ ...track.path, x0 } as PathDef)} />
          <Num label="From Y" value={track.path.y0} onChange={(y0) => setPath({ ...track.path, y0 } as PathDef)} />
          <Num label="To X" value={track.path.x1} onChange={(x1) => setPath({ ...track.path, x1 } as PathDef)} />
          <Num label="To Y" value={track.path.y1} onChange={(y1) => setPath({ ...track.path, y1 } as PathDef)} />
        </>
      )}
      {track.path.type === 'sine' && (
        <>
          <Num label="Mid Y" value={track.path.midV} onChange={(midV) => setPath({ ...track.path, midV } as PathDef)} />
          <Num label="Amplitude" value={track.path.amp} min={-1} max={1} onChange={(amp) => setPath({ ...track.path, amp } as PathDef)} />
          <Num label="Frequency" value={track.path.freq} min={0} max={8} step={0.25} onChange={(freq) => setPath({ ...track.path, freq } as PathDef)} />
          <Num label="Phase" value={track.path.phase} onChange={(phase) => setPath({ ...track.path, phase } as PathDef)} />
        </>
      )}
      {track.path.type === 'ellipse' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Radius X" value={track.path.rx} onChange={(rx) => setPath({ ...track.path, rx } as PathDef)} />
          <Num label="Radius Y" value={track.path.ry} onChange={(ry) => setPath({ ...track.path, ry } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}
      {track.path.type === 'spiral' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Inner radius" value={track.path.r0} onChange={(r0) => setPath({ ...track.path, r0 } as PathDef)} />
          <Num label="Outer radius" value={track.path.r1} onChange={(r1) => setPath({ ...track.path, r1 } as PathDef)} />
          <Num label="Turns" value={track.path.turns} min={0.25} max={12} step={0.25} onChange={(turns) => setPath({ ...track.path, turns } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}
      {track.path.type === 'polygon' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Size" value={track.path.size} onChange={(size) => setPath({ ...track.path, size } as PathDef)} />
          <Num label="Sides" value={track.path.sides} min={3} max={12} step={1} onChange={(sides) => setPath({ ...track.path, sides: Math.round(sides) } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}
      {track.path.type === 'poly' && (
        <>
          <Row label="Curviness">
            <input
              type="range" min={0} max={1} step={0.02}
              value={track.path.curviness}
              onChange={(e) => setPath({ ...track.path, curviness: Number(e.target.value) } as PathDef)}
            />
            <span className="muted num">{Math.round(track.path.curviness * 100)}</span>
          </Row>
          <Row label="Closed loop">
            <input
              type="checkbox"
              checked={track.path.closed}
              onChange={(e) => setPath({ ...track.path, closed: e.target.checked } as PathDef)}
            />
          </Row>
          <span className="muted">Click the preview to add points; drag to move; double-click a point to remove.</span>
        </>
      )}

      <hr className="sep" />

      {gradient ? (
        <>
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
              <option value="step">Step (hard)</option>
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

          <Row label="Image">
            <ImagePicker label="Use an image…" />
          </Row>
        </>
      ) : (
        <>
          <Row label="Image">
            <ImagePicker label="Replace…" />
            <button className="btn" onClick={setSourceGradient}>To gradient</button>
          </Row>
          <Row label="Transparency">
            <select value={source.kind === 'image' ? source.bg ?? 'white' : 'white'} onChange={(e) => setImageBg(e.target.value as 'white' | 'black')}>
              <option value="white">Over white</option>
              <option value="black">Over black</option>
            </select>
          </Row>
          <span className="muted">Transparent areas flatten over the chosen color (black = off). Keeps aspect ratio; the path samples it.</span>
        </>
      )}

      {!focused && rampOrCorners}

      <hr className="sep" />
      <div className="field-row">
        <span>Adjustments</span>
        <button
          className="btn"
          title="Reset all adjustments"
          onClick={() => updatePost({ invert: false, brightness: 0, contrast: 0, saturation: 0 })}
        >
          Reset
        </button>
      </div>
      <Row label="Invert">
        <input type="checkbox" checked={!!post.invert} onChange={(e) => updatePost({ invert: e.target.checked })} />
      </Row>
      <Adj label="Brightness" value={post.brightness ?? 0} onChange={(brightness) => updatePost({ brightness })} />
      <Adj label="Contrast" value={post.contrast ?? 0} onChange={(contrast) => updatePost({ contrast })} />
      <Adj label="Saturation" value={post.saturation ?? 0} onChange={(saturation) => updatePost({ saturation })} />
    </div>
  )
}

/** A bipolar adjustment slider (−100…+100, 0 = neutral). */
function Adj({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input type="range" min={-1} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="muted num">{value > 0 ? '+' : ''}{Math.round(value * 100)}</span>
    </Row>
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

function Num({
  label, value, onChange, min = 0, max = 1, step = 0.01,
}: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <Row label={label}>
      <input type="number" min={min} max={max} step={step} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  )
}

function pathOfType(type: PathDef['type']): PathDef {
  switch (type) {
    case 'line': return { type, x0: 0, y0: 0.5, x1: 1, y1: 0.5 }
    case 'sine': return { type, midV: 0.5, amp: 0.4, freq: 1, phase: 0 }
    case 'ellipse': return { type, cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.4, rot: 0 }
    case 'spiral': return { type, cx: 0.5, cy: 0.5, r0: 0.05, r1: 0.45, turns: 3, rot: 0 }
    case 'polygon': return { type, cx: 0.5, cy: 0.5, size: 0.4, sides: 3, rot: 0 }
    case 'poly':
      return { type, pts: [{ x: 0.25, y: 0.3 }, { x: 0.25, y: 0.7 }, { x: 0.75, y: 0.7 }], curviness: 0.5, closed: false }
  }
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

/** A button that picks an image file and sets it as the track's source (read as
 *  a data URL so it persists with the project). */
function ImagePicker({ label }: { label: string }) {
  const setSourceImage = useStore((s) => s.setSourceImage)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) {
            const reader = new FileReader()
            reader.onload = () => setSourceImage(reader.result as string, file.name.replace(/\.[^.]+$/, ''))
            reader.readAsDataURL(file)
          }
          e.target.value = ''
        }}
      />
      <button className="btn" onClick={() => ref.current?.click()}>{label}</button>
    </>
  )
}
