# LED Animator

Design LED animations in the browser and play them back on microcontrollers.

You author patterns in a web editor — place LEDs in 3D, sample gradients/textures
along per-track paths, tune speed/chase over a timeline — and everything **bakes
down to a fixed-rate raster** (row = LED, column = frame) that a device plays back
with a simple fixed-rate loop. The browser preview steps that same raster, so what
you see matches the hardware.

## Repository layout

This repo is organized so each app type lives in its own top-level folder:

| Folder | What it is | Status |
|---|---|---|
| [`web/`](web/) | The browser-based editor (Vite + React + three) | Active |
| _(planned)_ `ios/` | iPhone/iPad companion — BLE + WiFi control, AR placement | Not started |
| _(planned)_ `macos/` | Mac companion — BLE + WiFi + USB control | Not started |
| _(planned)_ `watch/` | Standalone watchOS remote — connect/list/select | Not started |
| _(planned)_ `firmware/` | Device player + control service (starting with RP2040) | Not started |

Project-wide files (this README, `LICENSE`, the GitHub Pages workflow in
`.github/`) live at the root; everything specific to the web app is inside `web/`.

Start with [`web/README.md`](web/README.md) to run the editor.

## License

[GNU AGPL-3.0](LICENSE).
