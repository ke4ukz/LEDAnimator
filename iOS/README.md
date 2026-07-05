# LED Animator — companion app (iOS / macOS)

> This folder (`iOS/`) is the SwiftUI companion app. See the
> [repository root](../README.md) for the whole project, and
> [`docs/protocol.md`](../docs/protocol.md) for the wire protocol it speaks.

A single SwiftUI app (iPhone / iPad / Mac via Universal Purchase) that discovers
LED Animator devices, connects over **Bluetooth LE** or **Wi‑Fi**, and controls
playback, appearance, and Wi‑Fi setup. It does **not** author patterns — that's
the [web editor](../web/). It plays and controls patterns already on a device.

## What it does

- **Discover** devices over BLE (scan filtered by the service UUID) and over
  Wi‑Fi (a UDP `LEDADISCOVER` probe), merged into one list — shown as a list or
  tiles.
- **Connect** over whichever transport is available; prefers Wi‑Fi, falls back to
  BLE. The control layer (`DeviceSession`) is transport-agnostic.
- **Control** — brightness, speed, solid color, off/on, select among the device's
  patterns, rename the device, and re-point the strip's data pin.
- **Wi‑Fi provisioning** — scan networks, enter credentials (stored *on* the
  device so it rejoins itself), check status, forget.
- **Info** — firmware version, LED count, free space, MAC(s), platform, and live
  power (USB present + VSYS voltage).
- **Upload** — copy a pattern to a device over Wi‑Fi (TCP).

## Architecture

| File | Role |
|---|---|
| `LED_AnimatorApp.swift` | App entry point. |
| `ContentView.swift` | Root; owns the BLE, Wi‑Fi, and discovery controllers; split-view on macOS, nav-stack on iOS. |
| `DeviceListView.swift` | The discovered-device browser (list / tiles). |
| `ControlView.swift` | Per-device control screen. |
| `DeviceInfoView.swift` | Details + rename + data-pin. |
| `WiFiView.swift` | Wi‑Fi provisioning UI. |
| `DeviceSession.swift` | Transport-agnostic control session (`@Observable`); turns UI intent into commands and tracks device state. |
| `Transport.swift` | The `DeviceTransport` abstraction shared by BLE and TCP. |
| `BLEController.swift` | CoreBluetooth scanning + connection + UART transport. |
| `TCPController.swift` | Wi‑Fi TCP transport + pattern upload. |
| `WiFiDiscovery.swift` | UDP broadcast discovery of Wi‑Fi devices. |
| `LEDProtocol.swift` | BLE UUIDs + the `LEDCommand` text protocol. |
| `PlatformModifiers.swift` | Small `#if os(...)` view helpers. |

The command strings are defined once in `LEDProtocol.swift` and run unchanged over
both transports — see [`docs/protocol.md`](../docs/protocol.md).

## Build & run

1. Open the Xcode project in this folder (`LED Animator/`).
2. Select an **iPhone/iPad** or **My Mac** run destination.
3. Run. On a real device you'll be prompted for **Bluetooth** (and **Local
   Network**, for Wi‑Fi discovery) permission — both are required to find devices.

Requires a device with Bluetooth; the Simulator can't do BLE, so use real
hardware (or run the Mac target) to exercise discovery.

## Source documentation

The Swift source is documented with `///` doc comments. Generate HTML with
Doxygen from the repo root:

```bash
doxygen Doxyfile
```

Or use Xcode's native **Build Documentation** (DocC), which reads the same
comments.
