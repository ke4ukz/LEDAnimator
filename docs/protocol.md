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

**Discovery** on Wi‑Fi is a **UDP probe**: the app broadcasts `LEDADISCOVER` to
the subnet on port 4550, and each device replies (UDP, to the sender) with:

```
LEDA <hostname> <name>
```

— its Wi‑Fi hostname and its user-visible device name. (BLE discovery is a normal
scan filtered by the service UUID above.)

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

### Multi-device sync

| Command | Meaning |
|---|---|
| `PROGRAM [n]` | The group **jukebox** verb. `PROGRAM <n>` plays program *n*: loads this device's own `NN-*.leda` slice and sets the beacon program #; on a leader this switches the whole group. No arg reports the current program #. |
| `ROLE` | **Read-only.** Reports `standalone` / `leader` / `leader-only` / `follower` / `auto` (`auto` resolves to leader or follower at boot by election). Role lives in the played file's [header](file-format.md) — change it by loading a different file, not with a command. |
| `GROUP` | **Read-only.** Reports the sync group id (also from the header). |
| `DEVICE` | **Read-only.** Reports the render-slice id (also from the header). |
| `TEARDOWN` | Leader-only. Gracefully ends the group: broadcasts the teardown flag for ~2 s so followers stop, then silences the beacon until reboot. `ERR not-leader` otherwise. |

Role / group / device-id are **not** set by command — they come from the `.leda`
header, so the file a device plays *is* its sync config (see
[`multi-device-sync.md`](multi-device-sync.md)). Program # is the file's `NN-`
name prefix.

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

Replies are text lines. On BLE they're TX notifications; on Wi‑Fi they're lines
on the TCP socket. Streamed responses are **paced** (~30 ms/line) so they don't
outrun a BLE link, and are framed by a length header and an end marker.

### `INFO` — the lean control state

```
INFO <mode> <bright%> <speed%> <r> <g> <b> <file...>
```

The filename is last so a name with spaces survives. `INFO` is both the reply to
the `INFO` command *and* an **unsolicited broadcast** whenever the device's state
changes — so every connected controller stays in sync. Live setter acks like
`BRIGHT <n>` and `SPEED <n>` are likewise echoed to all clients (debounced).

### `LIST` — pattern files

```
LISTLEN <count>          # reset the list; count follows
FILE <name>              # one per pattern (repeated)
...
ENDLIST                  # done
```

### `WIFISCAN` — nearby networks

```
WIFISCANLEN <count>
WIFINET <rssi> <ssid>    # rssi in dBm; ssid last so spaces survive (repeated)
...
WIFISCANEND
```

### `MOREINFO` — device details

A set of discrete, self-describing `KEY <value>` lines (order-independent; the
app ignores keys it doesn't recognize): `VERSION`, `LEDS`, `FREE`, `WIFIMAC`,
`BTMAC`, `HOSTNAME`, `PLATFORM`, `PIN`, and the sync state `ROLE`, `GROUP`,
`DEVICE`, `PROGRAM`, `STARTUP` (`wait`/`go`), `LOSS` (`indicate`/`silent`/
`blackout`), then `POWER`, closed by `ENDINFO`.

## Uploading a pattern (Wi‑Fi)

Bulk binary upload is **TCP-only** (it doesn't fit BLE's small writes). It's a
handshake around a raw byte stream of a [`.leda` file](file-format.md):

```
→  UPLOAD <length> <name>      # client announces size + target filename
←  OK UPLOAD                   # device ready (or  ERR args|name|size|open)
→  <length raw bytes>          # the client streams exactly <length> bytes
←  OK UPLOADED                 # device verified the LEDA magic + saved it
                               #   (or  ERR badfile  and the upload is discarded)
```

Playback pauses during the transfer and resumes afterward. The device validates
the [`LEDA` magic](file-format.md#header-16-bytes) before accepting the file, and
overwrites a same-named pattern.

## Notes for future transports

The protocol is intentionally free of transport specifics, so the planned USB
path (and anything else) can reuse `LEDCommand` verbatim. The multi-device sync
work ([`multi-device-sync.md`](multi-device-sync.md)) adds a *separate* BLE
advertising channel for clock sync and does not change these control commands.
