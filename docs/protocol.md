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
| `WHITEBAL <r> <g> <b>` | Set the per-channel **white-balance** gains 0–255 (the "canonical white"); applied at render to every color, so a value < 255 attenuates that channel. No-arg **queries** (reply `WHITEBAL <r> <g> <b>`). Persisted; broadcast to all clients. The app calibrates it live by showing solid white and dragging a warm/tint pad. |

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

### Maintenance

| Command | Meaning |
|---|---|
| `REBOOT` | **Warm-restart** the device: it acks `OK REBOOT`, waits a beat so the client sees the ack, then resets and re-runs boot. Config (name, brightness, selected pattern, Wi‑Fi, PIN) is reloaded from flash, so nothing is lost. A general maintenance convenience — a rename no longer needs it (the device re-advertises the new BLE name live). The connection drops during the reset; the device reappears (and can be reconnected) once it rejoins the network, ~5–10 s later. Auth-gated. |
| `BOOTSEL` | Reboot into the RP2040 **USB bootloader** (the `RPI-RP2` mass-storage drive) so a new firmware UF2 can be dropped on — no BOOTSEL button or `picotool` needed. The connection **drops immediately** (the chip resets), so there's no reply; the client then watches for the `RPI-RP2` drive to mount and copies the `.uf2`. Auth-gated like any non-`INFO` command. |

The intended flow (a Mac-side "update firmware" gesture, or by hand): send
`BOOTSEL` over the existing BLE/Wi‑Fi connection → the device appears as the
`RPI-RP2` drive → drag/copy a firmware `.uf2` onto it → it flashes and reboots
into the new firmware. Requires physical USB access, so it's a maintenance/dev
operation, not an end-user one. (The Rust firmware will grow the same command
once its control channel is ported; see [`../firmware-rust/docs/PORT.md`](../firmware-rust/docs/PORT.md).)

### Multi-device sync

| Command | Meaning |
|---|---|
| `PROGRAM [n]` | The group **jukebox** verb. `PROGRAM <n>` plays program *n*: loads this device's own `NN-*.leda` slice and sets the beacon program #; on a leader this switches the whole group. No arg reports the current program #. |
| `ROLE` | **Read-only.** Reports `standalone` / `leader` / `leader-only` / `follower` / `auto` (`auto` resolves to leader or follower at boot by election). Role lives in the played file's [header](file-format.md) — change it by loading a different file, not with a command. |
| `GROUP` | **Read-only.** Reports the sync group id (also from the header). |
| `DEVICE` | **Read-only.** Reports the render-slice id (also from the header). |
| `LOSS [indicate\|silent\|blackout\|default]` | Follower on-sync-loss policy. No arg reports it; a value **pins** it (device override, persisted, wins over the file header for every animation); `LOSS default` clears the override so the animation's header takes back over. |
| `STARTUP [wait\|go\|default]` | Follower boot behavior — wait-for-sync vs start-and-go. No arg reports; a value pins it (device override, persisted); `STARTUP default` clears the override. |
| `TEARDOWN` | Leader-only. Gracefully ends the group: broadcasts the teardown flag for ~2 s so followers stop, then silences the beacon until reboot. `ERR not-leader` otherwise. |

**Identity** (`ROLE`/`GROUP`/`DEVICE`) is read-only — it comes from the `.leda` header,
so the file a device plays *is* its identity (see
[`multi-device-sync.md`](multi-device-sync.md)); program # is the file's `NN-` name
prefix. **Behavior policies** (`LOSS`/`STARTUP`) default from each animation's header
— so uploading/switching a pattern applies *that* pattern's behavior — but each can
be **pinned independently** as a device override that wins over the header for every
animation until cleared with `… default`. Overrides live in `syncflags.txt` (only the
pinned fields are stored) and `MOREINFO` reports an `OVERRIDES` line so a controller
can warn that a device isn't following its animation.

### Auth (optional PIN lock)

A **casual deterrent** (keep a neighbor from poking your lights) — *not* protection
against physical access, which can reset the device (RP2350 secure boot is the real
lock). A PIN is stored on the device in `auth.txt`; no file ⇒ **open**.

| Command | Meaning |
|---|---|
| `LOGIN <hash>` | Authenticate this connection. `<hash>` = lowercase hex `sha256(pin + nonce)`, where `nonce` came from the `NEEDPIN` challenge. → `OK LOGIN` / `ERR auth` (wrong) / `ERR auth-wait` (rate-limited). |
| `SETPASS <pin>` | Set the PIN (**4–8 digits**). Refuses with `ERR exists` if one is **already set** (no silent overwrite between two connected apps) — `CLEARPASS` first, then set a new one. Authed-or-open. → `OK SETPASS` / `ERR exists` / `ERR args`. |
| `CLEARPASS` | Remove the PIN (unlock). Authed-only. → `OK CLEARPASS`. |

**When a PIN is set, the device is locked:** every command is refused with `ERR auth`
**except** `PING`, `LOGIN`, and `INFO` — and a locked+unauthenticated `INFO` returns a
challenge instead of the state line:

```
NEEDPIN <nonce_hex>       # fresh per connection; hash the PIN against it and LOGIN
```

The PIN never travels in the clear (challenge-response). Auth is **per connection**
and forgotten on disconnect. A wrong `LOGIN` starts a ~5 s window in which further
attempts return `ERR auth-wait` (non-blocking rate limit). While locked, unsolicited
state broadcasts are withheld from unauthenticated clients. `MOREINFO` reports `AUTH
set|none`. First-ever provisioning still works because a fresh device is open.

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
`blackout`), `OVERRIDES` (`none` | a comma list of the pinned policy fields, e.g.
`loss` / `loss,startup`), `AUTH` (`set` | `none` — is a PIN configured), then
`POWER`, closed by `ENDINFO`.

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
