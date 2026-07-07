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

The **language, authoring surface, and debugging** landed on **Lua + a block editor**
after weighing JS — see "Language, authoring & debugging" below. Whatever the surface,
the script runs **sandboxed** (a Web Worker and/or the wasm Lua VM you host, exposing
only a safe API), so a bad or runaway script can't wedge the editor — it's isolated and
killable, whether it returns a texture or a whole raster.

There are two integration points, at different levels of the existing pipeline. Both
fit as new **source** types on tracks.

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
returns the per-frame closure, so evolving sims keep frame-to-frame memory (Lua
closures work the same as JS's):

```lua
function setup(ctx)                 -- ctx = { leds, frames, fps, positions }
  local heat = {}                   -- persists across frames (closure upvalue)
  return function(pixels, frame, t)
    -- evolve `heat`, then write each pixel, using ctx.positions[i]
  end
end
```

The per-pixel "shader" mental model is available *inside* the render function (just
loop the pixels using their positions) — and since it's **offline in the browser**, the
per-pixel cost that hurts on-device is irrelevant here.

### Language, authoring & debugging

**Language: Lua** (this evolved from an initial JavaScript leaning). Deciding factors:
- **Portability** — the *same* script runs in the browser (preview/bake) **and
  on-device** in the compiled firmware (native Lua), since you'd never run JS on an
  RP2040. Write a "fire" generator once; preview it; ship it live.
- **Audience** — veteran JS devs aren't the target; makers / artists / educators are,
  and Lua's accessibility floor is proven (middle-schoolers ship Roblox games in it).
- **Debugging** (below) is *dramatically* easier in Lua.

**Runtime:** **wasmoon** (real Lua 5.4 in wasm) in the browser, native Lua on-device.
Both run sandboxed, exposing only a safe API (`set_pixel`, `positions`, `frame`,
`time`, `led_count`) — a script physically can't touch BLE/Wi-Fi/flash, and a line /
instruction hook can kill a runaway loop.

**Authoring: blocks first, text for power.** The primary surface is a **Blockly block
editor** — snap-together imperative code, the same model as **MakeCode** (which does
exactly this with kids and micro:bit LEDs). A **node / data-flow editor** (Blender-shader
style) was considered and **set aside**: bigger build, weaker at state/logic, and it
needs a shader-graph-literate maintainer; blocks map onto plain imperative code that's
easier to design, support, and debug.
- **Blockly generates Lua natively**, so blocks are just a friendly front-end emitting
  the same Lua the text tier and the device run — one language, one runtime, two ways in.
- **A small domain palette:** structure (`setup`, `for each LED`, `every frame`),
  inputs (`LED position x/y/z`, `frame #`, `time`, `index`, `count`), output (`set this
  LED to …`, `set whole strip …`), color/math (`HSV`, `gradient`, `noise`, arithmetic,
  `if` / `repeat`, variables). *"For each LED → set color from its Z and the time"* is a
  working pattern with no syntax.
- **Growth ramp:** a **"Show Lua"** button lowers blocks into editable text, so a user
  graduates from blocks to Lua (one-way generate is easy; round-trip isn't needed).
- **Text tier:** Monaco or CodeMirror 6 for the Lua source — highlighting is trivial;
  autocomplete is a convenience, not a requirement (full IDE-grade completion needs a
  Lua language server in-browser — a later nicety).

**Debugging flips in Lua's favor** — the weak spot for JS. You can't drive the browser's
native debugger from page code, so JS would mean *building* one (AST instrumentation or
a JS-in-JS interpreter). With Lua you **own the VM** *and* Lua ships a **debug library**:
`debug.sethook(fn, "l")` fires per line, and `debug.getlocal` / `getupvalue` / `getinfo`
read the scope. So a real step-debugger (run the script in a coroutine, `yield` at
breakpoints, inspect locals) is *natural*, not bolted on — exactly how **mobdebug /
ZeroBrane Studio** work. Bonuses:
- **Visual self-debugging** — a block editor can **highlight the running block** (Scratch
  does this); paired with the line hook you watch execution live and barely need a
  classic debugger.
- **On-device debugging** — native Lua has the same debug library, so the *same* approach
  debugs a script **running live on the Pico over the wire** (mobdebug is a remote Lua
  debugger). JS-on-device can't offer that — there's no JS there.
- **Domain-specific inspection** — patterns are deterministic, so "click an LED at a
  frame → see its inputs (position, frame, t) and computed color" stays the fastest way
  to answer "why is this pixel wrong," on top of any step-debugger.

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

## 4. White-label / OEM branding

For others building a product on this firmware + app. **Nearer-term-buildable than the
rest of this doc** — it rides the existing control protocol + export pipeline rather
than needing a rewrite.

### Brand logo in the device list (the near-term piece)

Let a designer embed a **logo** that the app shows in place of the light-bulb icon, so
their product looks like *theirs*.

- **Mechanism:** a small per-installation logo file lives on the device and is served
  over the control protocol; the app fetches it once, caches it, and shows it instead
  of the bulb (bulb = fallback when there's none).
- **Editor / export:** a per-*project* brand logo image (one brand per installation,
  like the group id), written into every device's bundle on export.
- **Firmware:** store `logo.png`; a `LOGO` command streams it over **TCP** — framed
  like `UPLOAD` reversed (`LOGO <len>` then `<len>` raw bytes). `MOREINFO` gains a flag
  that a logo exists (and optionally a short **brand id / hash**).
- **App:** on discovery, if a logo exists and isn't cached, fetch once over TCP, cache
  **by brand id** (one download per brand → the list renders instantly from cache),
  render instead of the bulb.
- **Format / size:** PNG (iOS/macOS decode natively). Keep it **small** — the Pico W
  filesystem is ~800 KB, so a 32 KB logo is ~5%; **aim for ~16 KB**, cap dimensions +
  bytes.
- **List vs. grid sizing:** a list-row icon is small (~40–80 px); a grid tile wants
  ~256 px+. Rather than ask for multiple sizes, **composite a designer's small mark
  into a supplied larger frame** (e.g. their logo inside a light-bulb) so one ~16 KB
  asset serves both. (Details for later — including the actual app row/tile sizes and
  the grid/list toggle.)
- **Transport:** Wi-Fi/TCP is the bulk channel; a BLE-only device shows the bulb until
  it's on Wi-Fi (chunk over BLE later if wanted).
- **Trust:** cosmetic — a device could advertise any logo; it's just an icon, not worth
  authenticating for this domain.

### Down-the-line branding

- **Brand / product name** — distinct from the per-device name; a small add once the
  logo path exists.
- **App accent color / theme** — let a brand tint the app to their color.
- Possible later: a bundled set of frame templates for the composite, brand-set default
  patterns, etc.

---

## Related

- **[`multi-device-sync.md`](multi-device-sync.md)** — the current sync design (the
  networked end of the lamp↔display spectrum).
- **[`file-format.md`](file-format.md)** / **[`protocol.md`](protocol.md)** /
  **[`sync-beacon.md`](sync-beacon.md)** — the language-agnostic contracts a compiled
  reimplementation would follow.
