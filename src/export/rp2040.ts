// MicroPython project for the RP2040: a PIO WS2812 driver + a fixed-rate player
// that reads pattern.bin (LEDA v1). Written to be readable and modifiable — a
// programmer can extend main() to hold several patterns and pick between them.

export function rp2040MainPy(pin: number): string {
  return `# main.py - LED Animator player for RP2040 (MicroPython)
# Plays pattern.bin (LEDA v1) on a WS2812 / NeoPixel strip using PIO.
#
# Wiring: strip data line -> GP${pin}, GND common with the strip's supply.
# Power: a Pico's USB can only source limited current; larger strips need an
# external 5V supply (lower BRIGHTNESS below to reduce current draw).
#
# Multiple patterns: keep several .bin files and choose which to open in main().

import array, time
from machine import Pin
import rp2

DATA_PIN = ${pin}
PATTERN_FILE = "pattern.bin"
BRIGHTNESS = 1.0  # 0.0-1.0

@rp2.asm_pio(sideset_init=rp2.PIO.OUT_LOW, out_shiftdir=rp2.PIO.SHIFT_LEFT,
             autopull=True, pull_thresh=24)
def ws2812():
    T1, T2, T3 = 2, 5, 3
    wrap_target()
    label("bitloop")
    out(x, 1)               .side(0)    [T3 - 1]
    jmp(not_x, "do_zero")   .side(1)    [T1 - 1]
    jmp("bitloop")          .side(1)    [T2 - 1]
    label("do_zero")
    nop()                   .side(0)    [T2 - 1]
    wrap()

sm = rp2.StateMachine(0, ws2812, freq=8_000_000, sideset_base=Pin(DATA_PIN))
sm.active(1)

_buf = None

def show(frame, n):
    global _buf
    if _buf is None or len(_buf) != n:
        _buf = array.array("I", bytes(4 * n))
    b = BRIGHTNESS
    for i in range(n):
        r = int(frame[i * 3] * b)
        g = int(frame[i * 3 + 1] * b)
        bl = int(frame[i * 3 + 2] * b)
        _buf[i] = (g << 16) | (r << 8) | bl   # WS2812 wants GRB
    sm.put(_buf, 8)

def main():
    f = open(PATTERN_FILE, "rb")
    h = f.read(16)
    if h[0:4] != b"LEDA":
        raise ValueError("not a LEDA pattern file")
    n = h[6] | (h[7] << 8)
    frames = h[8] | (h[9] << 8) | (h[10] << 16) | (h[11] << 24)
    fps = h[12] | (h[13] << 8)
    frame_bytes = n * 3
    delay = 1.0 / fps if fps else 0.03
    print("LEDs:", n, "frames:", frames, "fps:", fps)
    while True:
        f.seek(16)
        for _ in range(frames):
            show(f.read(frame_bytes), n)
            time.sleep(delay)

main()
`
}

export function rp2040Readme(pin: number): string {
  return `LED Animator - RP2040 (MicroPython) export

Files:
  main.py      WS2812 player (PIO). DATA_PIN is set to GP${pin}.
  pattern.bin  The baked animation (LEDA v1).

Install (Thonny or mpremote):
  1. Flash MicroPython for RP2040 onto the Pico / Pico W.
  2. Copy main.py and pattern.bin to the board.
  3. Reset - main.py runs on boot and loops the animation.

Wiring:
  Strip DIN -> GP${pin}; GND common; 5V from an adequate supply.

LEDA v1 binary format (little-endian):
  off size field
  0   4    magic 'LEDA'
  4   1    version (1)
  5   1    pixel format (0 = RGB888)
  6   2    numLeds (uint16)
  8   4    numFrames (uint32)
  12  2    fps (uint16)
  14  2    reserved
  16  ...  frame-major pixels: each frame is numLeds x (R,G,B)

The player steps one frame every 1/fps seconds, looping. To support multiple
patterns, ship several .bin files and choose which to open in main(), or add a
button/web interface to select between them.
`
}
