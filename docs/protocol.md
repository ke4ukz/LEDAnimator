# Device control protocol

The companion app and the device firmware speak a small **line-oriented text
protocol**: one command per message, an optional text reply. It's deliberately
transport-agnostic — the exact same command strings run over Bluetooth LE and
over Wi‑Fi (and will back a USB transport later).

- Firmware side: [`web/src/export/rp2040.ts`](../web/src/export/rp2040.ts) (the
  MicroPython player template).
- App side: [`iOS/LED Animator/LED Animator/LEDProtocol.swift`](../iOS/LED%20Animator/LED%20Animator/LEDProtocol.swift)
  (`LEDCommand` builds these strings; `LEDGATT` holds the BLE UUIDs).

## Transports

### Bluetooth LE

A custom **service UUID** identifies an LED Animator device (the device *name* is
user-settable, so the service UUID is the reliable filter). Commands and replies
use **Nordic-UART-style** characteristics.

| Role | UUID |
|---|---|
| Service (scan/filter on this) | `4C454441-0001-4000-8000-4C4544415254` |
| RX — write commands here | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX — replies arrive as notifications | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

Write one text command to **RX**; replies (and unsolicited state broadcasts)
arrive as notifications on **TX**.

The advertisement also carries **manufacturer data** — a `0xFFFF` company prefix
followed by a **3-byte device id** (hex). That id equals the device's Wi‑Fi
hostname suffix, so the app can recognize the *same physical device* whether it
finds it over BLE or over Wi‑Fi and show it once.

### Wi‑Fi (Pico W)

Once the device is on Wi‑Fi (provisioned via the `WIFI*` commands below), the
**same commands** are accepted over a plain **TCP socket on port 4550**,
newline-terminated. You can drive it by hand:

```bash
nc <device-ip> 4550
PING
```

**Discovery** on Wi‑Fi is a **UDP probe**: the app broadcasts `LEDADISCOVER` on
port 4550 and listening devices reply with their identity. (BLE discovery is a
normal scan filtered by the service UUID above.)

The app prefers Wi‑Fi when a device is reachable there and falls back to BLE.

## Commands

One command per message. Arguments are space-separated; a bare command with no
argument usually *queries* the value.

### Info & status

| Command | Meaning |
|---|---|
| `PING` | Liveness check. |
| `INFO` | Lean control state (name + current playback/appearance state). Also broadcast unsolicited when state changes. |
| `MOREINFO` | Heavier details, streamed: firmware version, LED count, free space, MAC(s), platform, power. |
| `VERSION` | Firmware build identifier. |
| `PLATFORM` | Board/platform string. |
| `FREE` | Free filesystem space. |
| `POWER` | Live power status (USB present + VSYS millivolts). |

### Playback & appearance

| Command | Meaning |
|---|---|
| `BRIGHT <0-100>` | Master brightness, percent. |
| `SPEED <10-400>` | Playback speed, percent of authored rate (100 = as authored). |
| `SOLID <r> <g> <b>` | Show a solid color (each channel 0–255). |
| `OFF` | Blank the strip. |
| `PLAY` | Resume the selected pattern. |

### Patterns

| Command | Meaning |
|---|---|
| `LIST` | Stream the pattern files on the device. |
| `SELECT <name>` | Make `<name>` the active pattern. |
| `DELETE <name>` | Remove a pattern file (not the active one). |

### Device configuration (persists across reboots)

| Command | Meaning |
|---|---|
| `NAME [new name]` | No arg reports the device name; with an arg, renames + persists. |
| `PIN [n]` | No arg reports the strip's data GP pin; `PIN <n>` re-points it live (0–29) + persists. |

### Wi‑Fi provisioning (Pico W)

| Command | Meaning |
|---|---|
| `WIFISCAN` | Stream nearby SSIDs (with signal strength). |
| `WIFISSID <ssid>` | Stash the network name for the next connect. |
| `WIFIPASS <pass>` | Stash the password for the next connect. |
| `WIFICONNECT` | Join with the stashed credentials + persist them. |
| `WIFISTATUS` | Report current Wi‑Fi state (and IP once joined). |
| `WIFIFORGET` | Clear saved credentials + disconnect. |

Credentials are entered in the app but **stored on the device**, so it rejoins on
its own after a reboot.

## Reply model

- Replies are text. Streamed responses (`LIST`, `WIFISCAN`, `MOREINFO`) arrive as
  a paced series of lines rather than one blob.
- `INFO` is both a reply to the `INFO` command *and* an unsolicited broadcast
  whenever the device's control state changes, so every connected controller
  stays in sync.
- On BLE, replies are TX notifications; on Wi‑Fi, they're lines on the TCP socket.

## Notes for future transports

The protocol is intentionally free of transport specifics, so the planned USB
path (and anything else) can reuse `LEDCommand` verbatim. The multi-device sync
work ([`multi-device-sync.md`](multi-device-sync.md)) adds a *separate* BLE
advertising channel for clock sync and does not change these control commands.
