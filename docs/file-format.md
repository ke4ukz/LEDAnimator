# Pattern file format — LEDA (`.leda`)

The `.leda` file is the **baked animation**: a small header followed by raw RGB
pixels, one value per LED per frame. It is the single contract shared by the web
editor (which writes it), the device firmware (which plays it), and the companion
app (which uploads it). Keep this document in sync with:

- Encoder: [`web/src/export/format.ts`](../web/src/export/format.ts)
- Player / reader: [`web/src/export/rp2040.ts`](../web/src/export/rp2040.ts)

## Design

A pattern is a **fixed-rate raster**: conceptually a grid where **each row is an
LED and each column is a frame**. The device plays it back with a dead-simple
loop — advance one column every `1/fps` seconds, wrap at the end — so there is no
interpolation, keyframing, or per-track logic on the device. All of that happened
at bake time in the editor.

On disk the grid is stored **frame-major**: all of frame 0's LEDs, then all of
frame 1's LEDs, and so on. That makes "show the next frame" a single contiguous
read of `numLeds × 3` bytes.

## Layout

All multi-byte integers are **little-endian**. A file is a **20-byte header**
followed by the pixel data.

### Header (20 bytes)

| Offset | Size | Field | Value / notes |
|---:|---:|---|---|
| 0 | 4 | **magic** | ASCII `LEDA` (`0x4C 0x45 0x44 0x41`) |
| 4 | 1 | **version** | `1` |
| 5 | 1 | **pixel format** | `0` = RGB888 (only format defined today) |
| 6 | 2 | **numLeds** | `uint16` — LEDs per frame |
| 8 | 4 | **numFrames** | `uint32` — frames in the loop |
| 12 | 2 | **fps** | `uint16` — frames per second |
| 14 | 1 | **role** | `0` standalone · `1` leader · `2` leader-only · `3` follower · `4` auto (first-boot election) |
| 15 | 1 | **group id** | `uint8` — sync group / installation (leaders broadcast it; followers filter on it) |
| 16 | 1 | **device id** | `uint8` — render-slice id (which device's slice this file is) |
| 17 | 1 | **sync flags** | bits 0–1 = on-sync-loss (`0` indicate · `1` silent · `2` blackout); bit 2 = startup (`0` wait-for-sync · `1` start-and-go) |
| 18 | 2 | **reserved** | `0` |

The **sync fields (role / group / device)** make the file its own role config:
the file a device plays *is* what tells it whether it's a standalone, a leader, or
a follower, and of which group — there is no separate role/group config on the
device (see [`multi-device-sync.md`](multi-device-sync.md)). The **program number**
is *not* in the header — it's the file's zero-padded `NN-` **name prefix**
(`07-aurora.leda` → program 7), the group's jukebox selection id.

A **leader-only** file (role `2`) is a header **with no pixel data** (`numLeds`
`0`, no body): the device runs the master clock + beacon from `numFrames`/`fps`
and drives no strip, so a group has a reference even where no strip is wired.

### Pixel data (starts at offset 16)

Frame-major, RGB888, 3 bytes per LED:

```
for frame in 0 .. numFrames-1:
    for led in 0 .. numLeds-1:
        R, G, B            # one byte each, 0-255
```

- **Body size** = `numFrames × numLeds × 3` bytes.
- **Total file size** = `20 + numFrames × numLeds × 3`.
- **LED order** is the physical **chain order** (wiring order). LEDs marked
  *unassigned* in the editor are dropped before encoding (they aren't wired), so
  index `l` here is the l-th wired LED, not the l-th LED in the 3D scene.
- Color is the LED's final baked color; runtime **brightness** and **speed** are
  applied by the player, not stored per pixel.

### Byte map (example: 60 LEDs, 120 frames, 30 fps)

```
0x00  4C 45 44 41            "LEDA"
0x04  01                     version 1
0x05  00                     RGB888
0x06  3C 00                  numLeds   = 60
0x08  78 00 00 00            numFrames = 120
0x0C  1E 00                  fps       = 30
0x0E  00                     role      = 0 (standalone)
0x0F  00                     group id  = 0
0x10  00                     device id = 0
0x11  00                     sync flags (on-loss policy)
0x12  00 00                  reserved
0x14  R G B R G B ...        frame 0: 60 LEDs × 3 = 180 bytes
      R G B R G B ...        frame 1: 180 bytes
      ...                    (120 frames total)
```

Total = `20 + 120 × 60 × 3` = **21,620 bytes**.

## How each side uses it

- **Editor** bakes the project to a raster and calls `encodeRaster()` to write
  exactly this. `estimateBytes()` computes the size without allocating (that's the
  number the Export dialog shows).
- **Firmware** opens the selected `.leda`, verifies the `LEDA` magic, reads
  `numFrames`/`numLeds`/`fps` from the header, then streams frames from offset 16
  in a fixed-rate loop.
- **Upload** (companion app, over Wi‑Fi/TCP) streams the whole file to the device;
  the firmware checks the `LEDA` magic before accepting it (see
  [`protocol.md`](protocol.md#uploading-a-pattern-wi-fi)).

## Reading a header (reference)

```python
# MicroPython-ish
h = f.read(20)
assert h[0:4] == b"LEDA"
version = h[4]
fmt     = h[5]                                   # 0 = RGB888
num_leds   = h[6]  | (h[7]  << 8)
num_frames = h[8]  | (h[9]  << 8) | (h[10] << 16) | (h[11] << 24)
fps        = h[12] | (h[13] << 8)
role       = h[14]                               # 0 standalone / 1 leader / 2 leader-only / 3 follower
group_id   = h[15]
device_id  = h[16]
# frame N pixels: seek(20 + N * num_leds * 3), read(num_leds * 3)
```

## Versioning & forward compatibility

- A reader **must** check `magic == "LEDA"` and reject anything else, and should
  check `version` and `pixel format` and refuse values it doesn't understand
  (rather than misinterpreting bytes).
- The **`version`** byte covers structural changes; the **`pixel format`** byte
  covers pixel encoding; byte 17 holds **sync flags** and the two **reserved**
  bytes (18–19) are for future flags/fields.
- **Planned formats** (see [`STATUS.md`](STATUS.md)) will use the pixel-format
  byte: e.g. RGB565 (2 B/pixel) or **indexed color** (1 B index + a palette
  section). Those add a new `pixel format` value — and, for indexed, a palette
  block between the header and the pixel data — while keeping the same magic +
  header shape. When that lands, document the new format value and any added
  sections here and bump this file's examples.

## Related

- **[Control protocol](protocol.md)** — how the app selects, uploads, and
  controls patterns.
- **[Project status](STATUS.md)** — the format-size levers (frame rate, pixel
  depth, per-device split) and why the firmware's fixed-stride playback shapes
  what encodings are practical.
