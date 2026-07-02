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

Non-destructive gradient generator (linear/radial/conic/dual-radial/bilinear/noise,
RGB/HSL/OKLCH/step interpolation), per-track sampling paths (line/sine/ellipse) with
on-texture drag editing, per-track speed-automation lane, 3D arrangement editor
(shape presets + multi-select + manual editing), editable timeline length/fps, an
RP2040 MicroPython export (program + `pattern.bin` + `project.json`, in a zip), and
project save/load (JSON, drag-and-drop import).

See the roadmap notes for the connectivity/native-app plans (BLE control, WiFi
provisioning, UF2 packaging, encodings, FSEQ).

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
