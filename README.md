# LED Animator

An in-browser, single-page editor for authoring LED animations and exporting them
for microcontroller playback.

You supply color-track texture images (gradients, blocks, transitions), place LEDs
in 3D, assign them to tracks that sample along a path across an image, and tune
per-track speed and chase offsets. A 3D viewport simulates the result. Everything
bakes down to a **fixed-rate raster** — one global frame interval, row = LED,
column = frame — so the runtime firmware is a single fixed-rate loop that reads a
flat array. The browser emulator plays that same raster by stepping it, so the
preview is identical to hardware.

## Status

Early scaffold. Working today:

- 3D simulation viewport (react-three-fiber) rendering LEDs from an arrangement.
- Fixed-rate player loop driving a baked demo raster (rainbow chase on a ring).
- DAW-style app shell (assets / arrangement / inspector / timeline placeholders).

Planned: image upload + path sampling → per-track speed-automation lane → 3D
arrangement editor → multi-track compositing → adaptive raster baker + export
(JSON, raw/RLE binary) → hardware packagers (C header, RP2040 UF2, MicroPython,
Pi Zero live mode).

## Develop

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build
npm run preview  # preview the production build
```

Stack: Vite + React + TypeScript + three / react-three-fiber + zustand.

## Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Enable Pages for the repo with **Source: GitHub
Actions**. The Vite `base` is relative, so it works under any repo name. (The
future on-Pi server mode is the exception and is hosted on the device itself.)

## License

[GNU AGPL-3.0](LICENSE). Because LED Animator is intended to run as a network
service in the on-Pi hosting mode, the AGPL ensures users interacting with a
hosted instance can obtain the corresponding source.
