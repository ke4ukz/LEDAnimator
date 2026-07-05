# LED Animator — Web editor

> This folder (`web/`) is the browser-based editor. See the [repository root](../README.md)
> for the overall project and the (planned) native apps.

An in-browser, single-page editor for authoring LED animations and exporting them
for microcontroller playback.

You supply color-track texture images (gradients, blocks, transitions), place LEDs
in 3D, assign them to tracks that sample along a path across an image, and tune
per-track speed and chase offsets. A 3D viewport simulates the result. Everything
bakes down to a **fixed-rate raster** — one global frame interval, row = LED,
column = frame — so the runtime firmware is a single fixed-rate loop that reads a
flat array. The browser emulator plays that same raster by stepping it, so the
preview is identical to hardware.

## Working today

- **Sources** — a non-destructive gradient generator (linear/radial/conic/
  dual-radial/bilinear/noise, with RGB/HSL/OKLCH/step interpolation) *or* a
  user-supplied **image** (aspect-preserved, transparency flattened over
  white/black). Per-source Adjustments (invert / brightness / contrast /
  saturation).
- **Sampling paths** — line / sine / ellipse / spiral / polygon / free-drawn
  **poly** (rounded corners, optional closed loop), edited by dragging handles
  on the texture. A **focus mode** enlarges the texture with a magnifier loupe
  and a live color/hex readout for pixel-precise handle and stop placement.
- **Tracks & timeline** — per-track speed + chase, a speed-automation lane,
  animation-index assignment, and editable timeline length / fps.
- **3D arrangement** — shape presets, multi-select, and manual per-LED editing;
  LED and animation index billboards.
- **Export** — for RP2040 (Pico / Pico W): a **one-drag UF2** (MicroPython +
  player + pattern), a **MicroPython `.zip`**, or the raw **`.leda`** pattern.
- **Projects** — save/load (JSON), a local project library (IndexedDB), and
  crash recovery.

Everything reads a single rasterized **source texture** (`texture.ts`) so the
loupe, timeline strip, and export all agree pixel-for-pixel with playback.

See [`../docs/`](../docs/) for the getting-started guide, control protocol, and
the multi-device sync plan.

## Develop

Run from this `web/` directory:

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build
npm run preview  # preview the production build
```

Stack: Vite + React + TypeScript + three / react-three-fiber + zustand.

## Deployment

Pushing to `main` builds this app (from `web/`) and publishes to GitHub Pages via
`.github/workflows/deploy.yml` at the repo root. Enable Pages for the repo with
**Source: GitHub Actions**. The Vite `base` is relative, so it works under any repo
name.

## License

[GNU AGPL-3.0](../LICENSE) — see the repository root.
