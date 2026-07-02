import type { LedPosition } from './types'

// Parametric arrangement generators. Each preset declares its parameters (so the
// UI can render controls generically) and builds LED positions centered on the
// origin. Add a preset by appending to ARRANGEMENTS — no UI changes needed.

export interface ArrangementParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export interface ArrangementPreset {
  name: string
  params: ArrangementParam[]
  build: (p: Record<string, number>) => LedPosition[]
}

const TAU = Math.PI * 2
const range = (n: number) => Array.from({ length: Math.max(0, Math.round(n)) }, (_, i) => i)

const P = (key: string, label: string, min: number, max: number, step: number, def: number): ArrangementParam => ({
  key, label, min, max, step, default: def,
})

export const ARRANGEMENTS: ArrangementPreset[] = [
  {
    name: 'Strip',
    params: [P('count', 'Count', 1, 1000, 1, 30), P('spacing', 'Spacing', 0.1, 3, 0.05, 0.6)],
    build: (p) => {
      const n = Math.round(p.count)
      return range(n).map((i) => ({ x: (i - (n - 1) / 2) * p.spacing, y: 0, z: 0 }))
    },
  },
  {
    name: 'Grid',
    params: [P('cols', 'Columns', 1, 64, 1, 8), P('rows', 'Rows', 1, 64, 1, 4), P('spacing', 'Spacing', 0.1, 3, 0.05, 0.7)],
    build: (p) => {
      const cols = Math.round(p.cols)
      const rows = Math.round(p.rows)
      const out: LedPosition[] = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          out.push({ x: (c - (cols - 1) / 2) * p.spacing, y: (r - (rows - 1) / 2) * p.spacing, z: 0 })
        }
      }
      return out
    },
  },
  {
    name: 'Ring',
    params: [P('count', 'Count', 2, 1000, 1, 24), P('radius', 'Radius', 0.5, 12, 0.1, 4)],
    build: (p) => {
      const n = Math.round(p.count)
      return range(n).map((i) => {
        const a = (i / n) * TAU
        return { x: Math.cos(a) * p.radius, y: Math.sin(a) * p.radius, z: 0 }
      })
    },
  },
  {
    name: 'Arc',
    params: [P('count', 'Count', 2, 1000, 1, 24), P('radius', 'Radius', 0.5, 12, 0.1, 4), P('sweep', 'Sweep°', 10, 360, 5, 180)],
    build: (p) => {
      const n = Math.round(p.count)
      const sweep = (p.sweep * Math.PI) / 180
      return range(n).map((i) => {
        const a = (n > 1 ? i / (n - 1) - 0.5 : 0) * sweep
        return { x: Math.sin(a) * p.radius, y: Math.cos(a) * p.radius - p.radius, z: 0 }
      })
    },
  },
  {
    name: 'Helix',
    params: [
      P('count', 'Count', 2, 2000, 1, 60),
      P('radius', 'Radius', 0.5, 12, 0.1, 3),
      P('turns', 'Turns', 0.5, 20, 0.5, 3),
      P('height', 'Height', 0.5, 30, 0.5, 8),
    ],
    build: (p) => {
      const n = Math.round(p.count)
      return range(n).map((i) => {
        const t = n > 1 ? i / (n - 1) : 0
        const a = t * p.turns * TAU
        return { x: Math.cos(a) * p.radius, y: Math.sin(a) * p.radius, z: (t - 0.5) * p.height }
      })
    },
  },
]

/** Default parameter values for a preset. */
export function defaultParams(preset: ArrangementPreset): Record<string, number> {
  return Object.fromEntries(preset.params.map((p) => [p.key, p.default]))
}
