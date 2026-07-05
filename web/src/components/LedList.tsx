import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { sampleRaster } from '../types'

/** Live current-color swatch for one LED. Isolated so the whole list doesn't
 *  re-render every frame. */
function LedSwatch({ index }: { index: number }) {
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const f = Math.min(frame, raster.numFrames - 1)
  const [r, g, b] = sampleRaster(raster, f, index)
  return <span className="swatch" style={{ background: `rgb(${r},${g},${b})` }} />
}

/** Editable order number: type a new index (Enter / blur) to move this LED
 *  there. Uncontrolled + commits from the ref so frame re-renders can't clobber
 *  the typed value. */
function OrderInput({ index, max, onCommit }: { index: number; max: number; onCommit: (n: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el) el.value = String(index)
  }, [index])
  const commit = () => {
    const n = parseInt(ref.current?.value ?? '', 10)
    if (!Number.isNaN(n) && n !== index) onCommit(n)
    if (ref.current) ref.current.value = String(index)
  }
  return (
    <input
      ref={ref}
      className="order"
      type="number"
      min={0}
      max={max}
      defaultValue={index}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}

/** Animation-index field: commits on Enter/blur (uncontrolled so a keystroke
 *  doesn't re-bake). Blank clears the override (back to the wiring default). */
function AnimInput({ value, onCommit }: { value: number | undefined; onCommit: (n: number | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el) el.value = value == null ? '' : String(value)
  }, [value])
  const commit = () => {
    const raw = ref.current?.value ?? ''
    onCommit(raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0))
  }
  return (
    <input
      ref={ref}
      className="order"
      type="number"
      min={0}
      placeholder="auto"
      defaultValue={value == null ? '' : String(value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}

/** LED list: live color swatch, click to select (Shift = range, Cmd/Ctrl =
 *  toggle), editable wiring order (#) + animation index (A), track assignment,
 *  and add/delete. `onAddShape` opens the arrangement (add-shape) dialog. */
export function LedList({ onAddShape }: { onAddShape: () => void }) {
  const leds = useStore((s) => s.leds)
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selection = useStore((s) => s.selection)
  const selectLed = useStore((s) => s.selectLed)
  const selectDeviceOf = useStore((s) => s.selectDeviceOf)
  const setSelection = useStore((s) => s.setSelection)
  const deviceSettings = useStore((s) => s.deviceSettings)
  const assignLed = useStore((s) => s.assignLed)
  const addLeds = useStore((s) => s.addLeds)
  const deleteLeds = useStore((s) => s.deleteLeds)
  const moveLedTo = useStore((s) => s.moveLedTo)
  const setLedAnimIndex = useStore((s) => s.setLedAnimIndex)
  const tool = useStore((s) => s.tool)
  const renumberNext = useStore((s) => s.renumberNext)
  const startRenumber = useStore((s) => s.startRenumber)
  const endRenumber = useStore((s) => s.endRenumber)
  const animAssignValue = useStore((s) => s.animAssignValue)
  const animAssignAuto = useStore((s) => s.animAssignAuto)
  const startAnimAssign = useStore((s) => s.startAnimAssign)
  const nextAnimAssign = useStore((s) => s.nextAnimAssign)
  const setAnimAssignAuto = useStore((s) => s.setAnimAssignAuto)
  const endAnimAssign = useStore((s) => s.endAnimAssign)
  const [start, setStart] = useState(0)
  const [animStart, setAnimStart] = useState(0)
  const [rangeFrom, setRangeFrom] = useState(0)
  const [rangeTo, setRangeTo] = useState(0)
  // Show the list as individual LEDs or grouped by device. Remembered across sessions.
  const [listMode, setListMode] = useState<'leds' | 'devices'>(
    () => (localStorage.getItem('leda.ledlist.mode') === 'devices' ? 'devices' : 'leds'),
  )
  useEffect(() => { localStorage.setItem('leda.ledlist.mode', listMode) }, [listMode])

  // Distinct device ids present, ascending, and the LED indices each contains.
  const deviceIds = [...new Set(leds.map((p) => p.device ?? 0))].sort((a, b) => a - b)
  const ledsOfDevice = (d: number) => leds.map((p, i) => ((p.device ?? 0) === d ? i : -1)).filter((i) => i >= 0)
  const selectDevice = (d: number, toggle: boolean) => {
    const idxs = ledsOfDevice(d)
    if (!toggle) return setSelection(idxs)
    // Toggle the whole device: remove it if fully selected, else add it.
    const sel = new Set(selection)
    if (idxs.every((i) => sel.has(i))) idxs.forEach((i) => sel.delete(i))
    else idxs.forEach((i) => sel.add(i))
    setSelection([...sel])
  }

  // Inclusive index range → LED indices, clamped to the chain.
  const rangeIndices = () => {
    const lo = Math.max(0, Math.min(rangeFrom, rangeTo))
    const hi = Math.min(leds.length - 1, Math.max(rangeFrom, rangeTo))
    const out: number[] = []
    for (let i = lo; i <= hi; i++) out.push(i)
    return out
  }
  const selectRange = (additive: boolean) =>
    setSelection(additive ? [...new Set([...selection, ...rangeIndices()])] : rangeIndices())

  // Escape leaves whichever click tool is active.
  useEffect(() => {
    if (tool === 'select') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (tool === 'renumber') endRenumber()
      else if (tool === 'animassign') endAnimAssign()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, endRenumber, endAnimAssign])

  return (
    <div className="led-list">
      <div className="led-list-head">
        <div className="list-mode-toggle">
          <button className={listMode === 'leds' ? 'btn btn-primary' : 'btn'} onClick={() => setListMode('leds')}>LEDs</button>
          <button className={listMode === 'devices' ? 'btn btn-primary' : 'btn'} onClick={() => setListMode('devices')}>Devices</button>
        </div>
        <span className="muted">
          {listMode === 'leds'
            ? `${leds.length} LEDs · Shift = range, ⌘/Ctrl = toggle, Alt = device`
            : `${deviceIds.length} device${deviceIds.length === 1 ? '' : 's'} · ⌘/Ctrl/Shift = toggle`}
        </span>
      </div>
      {listMode === 'devices' ? (
        <ul>
          {deviceIds.map((d) => {
            const idxs = ledsOfDevice(d)
            const allSel = idxs.length > 0 && idxs.every((i) => selection.includes(i))
            const name = deviceSettings[d]?.name?.trim()
            return (
              <li key={d} className={allSel ? 'sel' : ''} onClick={(e) => selectDevice(d, e.metaKey || e.ctrlKey || e.shiftKey)}>
                <span className="idx">{d}</span>
                <span>{name || `Device ${d}`}</span>
                <span className="tag">{idxs.length} LED{idxs.length === 1 ? '' : 's'}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul>
          {leds.map((_, i) => (
            <li
              key={i}
              className={selection.includes(i) ? 'sel' : ''}
              onClick={(e) =>
                e.altKey
                  ? selectDeviceOf(i, e.metaKey || e.ctrlKey || e.shiftKey ? 'toggle' : 'replace')
                  : selectLed(i, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')
              }
            >
              <LedSwatch index={i} />
              <span className="hash muted" title="Wiring order (export)">#</span>
              <OrderInput index={i} max={leds.length - 1} onCommit={(n) => moveLedTo(i, n)} />
              <span className="hash muted" title="Animation index (shared = animate together)">A</span>
              <AnimInput value={leds[i].animIndex} onCommit={(n) => setLedAnimIndex([i], n)} />
              <select
                className="led-track"
                value={assignments[i]}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => assignLed(i, e.target.value)}
              >
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      <div className="led-list-actions">
        <button className="btn" onClick={onAddShape}>Add shape…</button>
        <button className="btn" onClick={() => addLeds([{ x: 0, y: 0, z: 0 }])}>+ LED</button>
        <button className="btn" disabled={selection.length === 0} onClick={() => deleteLeds(selection)}>
          Delete{selection.length > 1 ? ` (${selection.length})` : ''}
        </button>
      </div>

      {tool === 'renumber' ? (
        <div className="renumber-bar active">
          <span>Click LEDs in order — next <strong>#{renumberNext}</strong></span>
          <button className="btn" onClick={endRenumber}>Done</button>
        </div>
      ) : tool === 'animassign' ? (
        <div className="renumber-bar active anim">
          <span>Click LEDs — anim <strong>#{animAssignValue}</strong></span>
          <label className="muted anim-auto" title="Each click bumps the number (sequential) instead of sharing it (grouping).">
            <input type="checkbox" checked={animAssignAuto} onChange={(e) => setAnimAssignAuto(e.target.checked)} />
            auto +1
          </label>
          <button className="btn" onClick={nextAnimAssign} disabled={animAssignAuto} title="Start the next group">Next #</button>
          <button className="btn" onClick={endAnimAssign}>Done</button>
        </div>
      ) : (
        <>
          <div className="renumber-bar">
            <label className="muted">Select #</label>
            <input
              className="order"
              type="number"
              min={0}
              max={Math.max(0, leds.length - 1)}
              value={rangeFrom}
              onChange={(e) => setRangeFrom(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <span className="muted">to</span>
            <input
              className="order"
              type="number"
              min={0}
              max={Math.max(0, leds.length - 1)}
              value={rangeTo}
              onChange={(e) => setRangeTo(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <button className="btn" disabled={leds.length === 0} onClick={() => selectRange(false)}>Select</button>
            <button className="btn" disabled={leds.length === 0} onClick={() => selectRange(true)} title="Add this range to the current selection">Add</button>
          </div>
          <div className="renumber-bar">
            <label className="muted">Renumber (wiring) from</label>
            <input
              className="order"
              type="number"
              min={0}
              max={Math.max(0, leds.length - 1)}
              value={start}
              onChange={(e) => setStart(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <button className="btn" disabled={leds.length === 0} onClick={() => startRenumber(start)}>Start</button>
          </div>
          <div className="renumber-bar">
            <label className="muted">Assign anim # from</label>
            <input
              className="order"
              type="number"
              min={0}
              value={animStart}
              onChange={(e) => setAnimStart(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <button className="btn" disabled={leds.length === 0} onClick={() => startAnimAssign(animStart)}>Start</button>
          </div>
        </>
      )}
    </div>
  )
}
