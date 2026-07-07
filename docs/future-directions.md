# Future directions & design notes

Forward-looking design exploration (captured 2026-07-06). **None of this is built
yet** — the current firmware is a MicroPython prototype and the editor bakes with
built-in sources. This records the *reasoning* behind where the project could go so
the direction isn't lost, and so the near-term work (protocol/format formalization,
the dumb-raster player) is understood as groundwork for it.

**Guiding principle — author-heavy, play-cheap.** Do the expensive, creative work at
*author* time (bake in the browser) or *occasionally* (generate once on-device), and
keep the runtime hot path a dumb, robust, portable **fixed-rate raster player**.
Scripting layers on at the *edges* — author-side generation and device-side
control/reactivity — without making the core fragile. Everything below follows from
that.

---

## 1. Browser-side pattern scripting (author-side)

The strongest near-term direction. Let users write a script **in the browser** that
generates patterns, baked into `.leda` files. The firmware stays a dumb raster
player — no on-device VM, no new runtime failure modes, and it ports cleanly to a
compiled binary later.

**Language: JavaScript.** Native, JIT-fast, zero runtime to ship, best tooling,
WebGL/WebGPU available if wanted. The *only* reason to embed **Lua in the browser**
(via Fengari or wasm-Lua) is if you want the **same script to run on-device too** —
because you'd never run JS on an RP2040, so the shared language would be Lua. But
browser-bake and on-device-react are different jobs, so best-tool-per-job says JS in
the browser. Only reach for Lua-in-browser for the narrow "portable generator" case.

**Sandbox: a Web Worker.** Isolated from the DOM, and you can time it out and kill it
if a user script hangs. This is what makes handing control to a user-supplied script
safe — and it's identical whether the script returns a texture or a whole raster.

Two integration points, at different levels of the existing pipeline. Both fit as new
**source** types on tracks.

### 1a. Texture mode (build this first)

The script generates a **2-D texture**; its output flows through the **existing**
path / track / animation machinery unchanged (sampled along each LED's path at an
animated position). Why it's the strong one:

- **Composes with everything already built** — paths, per-track animation, layering.
  The motion comes for free from the path scrolling through the generated texture.
- **Least new machinery** — just a new source that produces a texture; the bake loop,
  sampling, and swatch/loupe preview stay the same.
- **Refines in two independent knobs** — tweak the script → texture updates in the
  swatch → maps into the 3-D view; then tune the *track* params (speed/chase)
  separately.
- **Kills the external-tool workflow** — custom multi-stop gradients, procedural
  noise, fractals, plasma that you'd otherwise make in Photoshop/Processing and
  upload now live *in* the app, reproducible and serialized in `project.json`.

Covers most "patterns the built-in tools can't do," because a lot of those are really
*textures* the built-in gradient/image editor can't make. Textures are static images;
the animation is the path scrolling through them.

### 1b. Timeline mode — the global control function (escape hatch)

The script writes the **final raster** directly (per-frame), **bypassing paths and
tracks**. The key power is **global awareness**: the function sees *every* LED's real
3-D position plus the timeline cursor at once, so it can express *relationships
between LEDs* that the track model architecturally cannot — a track is a *local*
operator (its own slice, its own path, blind to the rest).

"One function vs. many tracks" — things this unlocks:
- A **ripple/wave through 3-D space**: each LED lights on `distance-from-source −
  time·speed`. One expression vs. hand-tuned concentric track groups.
- A **sweep plane** slicing the piece, lighting LEDs as it passes (position · moving
  plane). One function vs. dozens of path segments.
- **Position-conditioned timing** — "everything pulses, but later the higher it sits,"
  so a glow rises up a sculpture. Nonlinear coupling of time to space.
- **Neighbor-aware fields** — reaction-diffusion, cellular automata, flocking — across
  the *actual* geometry. No track equivalent exists.

It stops treating the piece as a *strip* and treats it as a **3-D point cloud / field**
— true volumetric effects, the editor's position data as a genuine superpower a
1-D-strip tool can't reach.

And because it **bakes**, the function can be **arbitrarily expensive** — O(N²)
inter-LED work, multi-pass sims, look-ahead — none of it real-time. You pay once at
bake; the device plays a cheap raster. A modest RP2040 can *display* a
reaction-diffusion sim across 3-D space it could never *compute* live.

### Dividing line & API

- **Static + spatial → texture mode** (the path animates it). E.g. a custom noise
  gradient, a fractal.
- **Temporal / evolving / genuinely per-LED → control function.** E.g. **fire** — it
  *evolves* frame to frame, which a scrolled static texture can't capture.

**API shape:** per-frame callback is the primitive (a "whole timeline" call is just
the engine looping over it → progress/cancel for free). Feed it rich context —
especially **each LED's 3-D position**. Handle state with a one-time `setup()` that
returns the per-frame closure, so evolving sims keep frame-to-frame memory:

```js
export function setup({ leds, frames, fps, positions }) {
  const heat = new Float32Array(leds)          // persists across frames
  return function render(pixels, { frame, t }) {
    // evolve `heat`, then write pixels (Uint8 RGB triples), using positions[i]
  }
}
```

The per-pixel "shader" mental model is available *inside* `render` (just loop the
pixels using their positions) — and since it's **offline in the browser**, the
per-pixel cost that hurts on-device is irrelevant here.

### Complementary to tracks, not a replacement

Tracks are the WYSIWYG, no-code, directly-manipulable "paint motion along a path"
tool — better for many hand-authored looks *because* they're immediate and
composable. The control function is the computed-field power tool. And they layer: a
function's output can be *one track's* contribution alongside hand-authored tracks.

---

## 2. Compiled firmware & productization

Migrate the frozen prototype from MicroPython to a **compiled binary** once behavior +
protocol are locked — for performance, robustness, and IP protection.

- **Nothing we use is MicroPython-exclusive.** PIO/DMA are native in the Pico C SDK;
  **BLE via BTstack** (`pico_btstack` — the same stack MicroPython wraps); Wi-Fi/TCP
  via `cyw43_arch` + **lwIP**. The cost is boilerplate: BLE/Wi-Fi one-liners become
  hundreds of lines.
- **Rust (embassy-rp) is arguably the better compiled target** than C — mature `cyw43`
  Wi-Fi driver, async runtime, first-class PIO/DMA, memory safety, improving BLE.
  **C# on RP2040** (.NET nanoFramework) exists but its CYW43 BLE/Wi-Fi support is weak
  — skip it.
- **The protocol/format docs are the language-agnostic spec** — `sync-beacon.md`,
  `file-format.md`, `protocol.md`. That's what makes a rewrite a *reimplementation*
  rather than reverse-engineering. Formalizing them now is exactly the groundwork.
- **IP protection — deterrent vs. DRM.** A compiled binary is a real deterrent versus
  a plaintext `main.py` anyone can pull with `mpremote` and edit. **But the base
  RP2040 has no flash read-protection or secure boot** — the flash can be dumped over
  SWD or the bootrom regardless of language. So it's obfuscation-by-effort, not DRM.
  For *real* protection, the **RP2350 / Pico 2** has **secure boot** (signature-verified
  images, OTP-stored keys). Path: compiled binary = deterrent; compiled + RP2350
  secure boot = actual lockdown.
- **Sequencing:** MicroPython **now** (why we iterate this fast), compiled **Rust on
  RP2350 later** (hardening/productization). Don't rewrite mid-prototype.

---

## 3. On-device scripting (Lua) & the lamp tier

For runtime customization and standalone products, embed a **sandboxed scripting VM
(Lua)** in the compiled firmware.

**Lua's role is the device's *behavior/config*, not per-pixel rendering.** A curated
menu of modes (warm white, cool white, rainbow, fire), input handling (a GPIO button
cycles modes; a temperature sensor selects one), transitions — while the heavy pixel
work stays native. Three ways Lua can touch pixels, pick per effect:

- **Selector** (cheapest): picks/schedules baked `.leda` patterns and handles inputs.
  Never touches a pixel; runs on events; ~zero per-frame cost.
- **Generator** (runs once): Lua fills a raster once → cached as a temp `.leda` → the
  dumb player plays it. Good for deterministic parametric patterns. (A generated
  raster still loops, so *not* for fire.)
- **Per-frame renderer**: only for modest strips / simple effects, or Lua sets a few
  params and native code renders per-pixel. Fire lives here (a tiny non-looping heat
  sim, cheap per LED).

**Sandboxing:** expose only a safe API (`set_pixel`, `frame`, `time`, `led_count`) so
a script physically *can't* touch BLE/Wi-Fi/flash, and install an **instruction-count
hook to kill runaway loops**. Far safer than shipping arbitrary `.py` (full system
access → bricks the device). We already follow this instinct: users can only upload
`.leda` *data*, never code.

**Standalone lamp tier (non-W Pico 2).** A cheap lamp doesn't need the CYW43 at all —
drop BLE/Wi-Fi/sync entirely and you're left with **player + input + optional Lua**, a
much smaller/robust firmware and cheaper BOM. One shared core, a feature spectrum:

- **Standalone lamp** — RP2350 (non-W), GPIO/sensor input, hardcoded or Lua behavior,
  no radio.
- **Networked synced display** — Pico 2 W, the full stack (BLE provisioning + beacon
  sync + Wi-Fi control).

### Performance realities (why per-pixel-per-frame Lua is the wrong shape)

- The **per-pixel "shader" model is the worst on-device form**: `N` C↔Lua boundary
  crossings per frame, and unlike a GPU there's **no parallelism** (one core,
  interpreted). Fine for a few hundred LEDs with simple integer math; **blows the
  frame budget** at large `N` or float/noise math (the RP2040 M0+ has **no FPU** →
  software-emulated floats).
- **Efficient form:** one call per frame, Lua loops filling a **buffer** (no per-pixel
  C boundary). Or bake (the generator trick). The boundary cost is *architectural* —
  don't cross it per pixel.
- **RP2350 changes the math:** single-precision **FPU** (float shaders become cheap),
  higher clock, M33 cores. Per-pixel Lua shaders become viable there for modest strips.
- **Dual-core (both RP2040 *and* RP2350 are dual — the "2" in the name = 2 cores)**
  does **not** cheapen the C↔Lua boundary, so "hand off to core 1 and wait" is
  pointless. Productive patterns:
  - **Overlap** — core 1 renders frame N+1 while core 0 does DMA shift-out + BLE +
    sync. The render gets its *own* core and stops competing for the frame budget.
    (This is the DMA double-buffer pipeline, extended one step.)
  - **Split** — two *independent* Lua states, each rendering half the strip → ~2×, with
    one barrier per frame before the DMA kick (the WS2812 chain is serial). Needs two
    Lua VMs — a **compiled-firmware** capability, **not** MicroPython (its GIL means
    `_thread` on core 1 still shares one lock).
  - Use cores for *overlap* (nearly free, hides latency), not to brute-force a
    wrong-shaped per-pixel shader.

---

## Related

- **[`multi-device-sync.md`](multi-device-sync.md)** — the current sync design (the
  networked end of the lamp↔display spectrum).
- **[`file-format.md`](file-format.md)** / **[`protocol.md`](protocol.md)** /
  **[`sync-beacon.md`](sync-beacon.md)** — the language-agnostic contracts a compiled
  reimplementation would follow.
