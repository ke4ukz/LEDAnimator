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
| 5 | 1 | **pixel format** | `0` = RGB888 · `1` = RGB565 · `2` = indexed (see [Pixel formats](#pixel-formats)) |
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

### Pixel data (starts at offset 20)

Frame-major, one pixel per LED per frame. The **pixel format** byte picks the
per-pixel encoding (see [Pixel formats](#pixel-formats)); the default RGB888 is
3 bytes per LED:

```
for frame in 0 .. numFrames-1:
    for led in 0 .. numLeds-1:
        R, G, B            # one byte each, 0-255
```

- **Body size** = `numFrames × numLeds × 3` bytes (RGB888).
- **Total file size** = `20 + numFrames × numLeds × 3` (RGB888).
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

## Pixel formats

The **pixel format** byte (offset 5) selects how each LED's color is stored. The
header shape is identical for all of them; only the per-pixel size and (for
indexed) an added palette block differ. The editor picks the format at export
time — the color you authored is the same; this is purely a size/precision trade.

| Value | Name | Per-LED | Notes |
|---:|---|---:|---|
| 0 | **RGB888** | 3 B | `R, G, B`, 0-255 each. Exact. Default. |
| 1 | **RGB565** | 2 B | `uint16` LE, `RRRRRGGG GGGBBBBB` (5-6-5). ~⅓ smaller; slight color-depth loss. |
| 2 | **Indexed** | 1 B | One palette **index** per LED; colors live in a palette block (below). Smallest when a pattern uses few distinct colors. |

**RGB565** packs `(r>>3)<<11 | (g>>2)<<5 | (b>>3)`. A reader expands each channel
back to 8 bits by **bit-replicating** the high bits (e.g. `r8 = (r5<<3)|(r5>>2)`)
so full values stay 255, not 248/252.

**Indexed** inserts a **palette block** between the header and the pixel data:

| Offset | Size | Field |
|---:|---:|---|
| 20 | 2 | **palette count** `N` (`uint16` LE, 1-256) |
| 22 | `N × 3` | palette entries, RGB888 |
| `22 + N×3` | … | index bytes — one `uint8` per LED per frame, frame-major |

- **Body size** = `numFrames × numLeds × 1` index bytes.
- **Total file size** = `20 + 2 + N×3 + numFrames × numLeds`.
- The palette is **per file**, so a multi-device export gives each device a palette
  built from only the colors *its* slice shows.
- The editor builds the palette automatically: **lossless** when a file has ≤ 256
  distinct colors, otherwise **median-cut quantized** to 256 (the export UI warns
  and lets the user proceed with the approximation or stop and adjust).

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
fmt     = h[5]                                   # 0 RGB888 / 1 RGB565 / 2 indexed
num_leds   = h[6]  | (h[7]  << 8)
num_frames = h[8]  | (h[9]  << 8) | (h[10] << 16) | (h[11] << 24)
fps        = h[12] | (h[13] << 8)
role       = h[14]                               # 0 standalone / 1 leader / 2 leader-only / 3 follower
group_id   = h[15]
device_id  = h[16]
# RGB888: frame N pixels at seek(20 + N * num_leds * 3), read(num_leds * 3)
# (RGB565: ×2 not ×3; indexed: skip the palette block first, then ×1)
```

## Versioning & forward compatibility

- A reader **must** check `magic == "LEDA"` and reject anything else, and should
  check `version` and `pixel format` and refuse values it doesn't understand
  (rather than misinterpreting bytes).
- The **`version`** byte covers structural changes; the **`pixel format`** byte
  covers pixel encoding; byte 17 holds **sync flags** and the two **reserved**
  bytes (18–19) are for future flags/fields.
- A reader that doesn't recognize the **`pixel format`** value must refuse the
  file (the firmware treats an unknown format like a bad magic) rather than
  misread the body. Formats `0`–`2` are defined above; new ones take the next
  value (and document any added section here).

## Related

- **[Control protocol](protocol.md)** — how the app selects, uploads, and
  controls patterns.
- **[Project status](STATUS.md)** — the format-size levers (frame rate, pixel
  depth, per-device split) and why the firmware's fixed-stride playback shapes
  what encodings are practical.
