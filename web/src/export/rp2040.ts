// MicroPython project for the RP2040 / Pico W: a PIO WS2812 driver + a
// fixed-rate player that reads pattern.bin (LEDA v1), plus an optional Bluetooth
// LE control channel (a custom LED Animator service with UART-style characteristics)
// for live brightness / speed / solid color / pattern selection. The BLE half is
// skipped automatically on a plain
// Pico (no radio), so the same script runs on both.

export function rp2040MainPy(pin: number, brightness: number, name = 'LED Animator'): string {
  return `# main.py - LED Animator player for RP2040 / Pico W (MicroPython)
# Plays pattern.bin (LEDA v1) on a WS2812 / NeoPixel strip using PIO, and on a
# Pico W exposes a Bluetooth LE control channel for live control.
#
# Wiring: strip data line -> GP${pin}, GND common with the strip's supply.
# Power: a Pico's USB can only source limited current; larger strips need an
# external 5V supply (lower BRIGHTNESS / use the BLE BRIGHT command).
#
# BLE control - a custom LED Animator service (so an app can filter scans to
# OUR devices; the name is user-set and UART UUIDs are shared, so neither is
# unique) with UART-style characteristics (so nRF Connect / LightBlue still work):
#   Service     4C454441-0001-4000-8000-4C4544415254   (advertised; scan filter)
#   RX (write)  6E400002-B5A3-F393-E0A9-E50E24DCCA9E
#   TX (notify) 6E400003-B5A3-F393-E0A9-E50E24DCCA9E
# Send one text command per write to RX; the reply arrives as a TX notify.
#   PING | INFO | LIST | FREE | SELECT <name> | BRIGHT <0-100> |
#   SPEED <10-400> | SOLID <r> <g> <b> | OFF | PLAY | DELETE <name> |
#   NAME [new name]  (no arg reports it; setting it persists across reboots)

import array, time, os
from machine import Pin
import rp2

DATA_PIN = ${pin}
PATTERN_FILE = "pattern.bin"
DEVICE_NAME = ${JSON.stringify(name)}   # default BLE name; NAME command overrides


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


class S:
    bright = ${brightness}   # 0.0 - 1.0, scales every channel
    speed = 1.0              # playback rate multiplier (1.0 = as authored)
    mode = "play"            # "play" or "solid"
    solid = (0, 0, 0)
    file = PATTERN_FILE
    reload = True
    n = 0                    # LED count of the loaded pattern
    name = DEVICE_NAME       # advertised BLE name (overridable at runtime)
    ble = None               # set once BLE is up, so NAME can update gap_name


_buf = None


def _show_grb(frame, n):
    global _buf
    if _buf is None or len(_buf) != n:
        _buf = array.array("I", bytes(4 * n))
    b = S.bright
    for i in range(n):
        r = int(frame[i * 3] * b)
        g = int(frame[i * 3 + 1] * b)
        bl = int(frame[i * 3 + 2] * b)
        _buf[i] = (g << 16) | (r << 8) | bl   # WS2812 wants GRB
    sm.put(_buf, 8)


def _show_solid(rgb, n):
    global _buf
    if n <= 0:
        return
    if _buf is None or len(_buf) != n:
        _buf = array.array("I", bytes(4 * n))
    b = S.bright
    v = (int(rgb[1] * b) << 16) | (int(rgb[0] * b) << 8) | int(rgb[2] * b)
    for i in range(n):
        _buf[i] = v
    sm.put(_buf, 8)


def list_patterns():
    out = []
    for name in os.listdir():
        if name.endswith(".bin"):
            out.append(name)
    return out


def _free_bytes():
    try:
        st = os.statvfs("/")
        return st[0] * st[3]
    except Exception:
        return 0


def _load_name():
    try:
        with open("device.name") as fh:
            nm = fh.read().strip()
            if nm:
                return nm
    except OSError:
        pass
    return DEVICE_NAME


def _load_current():
    # Restore the last SELECTed pattern, if it still exists.
    try:
        with open("selected.txt") as fh:
            nm = fh.read().strip()
        if nm and nm in list_patterns():
            return nm
    except OSError:
        pass
    return PATTERN_FILE


def dispatch(line):
    # Transport-agnostic command handler. Returns a short reply string.
    # Reused as-is by any future transport (Wi-Fi/HTTP, USB serial).
    line = line.strip()
    if not line:
        return None
    p = line.split()
    c = p[0].upper()
    try:
        if c == "PING":
            return "OK"
        if c == "INFO":
            return "INFO %s %d %s %d %d" % (
                S.file, S.n, S.mode, int(S.bright * 100), int(S.speed * 100))
        if c == "NAME":
            if len(p) < 2:
                return "NAME " + S.name
            new = line.split(None, 1)[1].strip()[:26]
            if not new:
                return "ERR args"
            S.name = new
            try:
                with open("device.name", "w") as fh:
                    fh.write(new)
            except Exception:
                pass
            try:
                S.ble.config(gap_name=new)
            except Exception:
                pass
            return "OK NAME " + new
        if c == "LIST":
            return "LIST " + ",".join(list_patterns())
        if c == "FREE":
            return "FREE %d" % _free_bytes()
        if c == "SELECT":
            name = line.split(None, 1)[1].strip()
            if name in list_patterns():
                S.file = name
                S.mode = "play"
                S.reload = True
                try:
                    with open("selected.txt", "w") as fh:
                        fh.write(name)
                except Exception:
                    pass
                return "OK SELECT " + name
            return "ERR no-file"
        if c == "BRIGHT":
            S.bright = max(0, min(100, int(p[1]))) / 100.0
            return "OK BRIGHT %d" % int(S.bright * 100)
        if c == "SPEED":
            S.speed = max(10, min(400, int(p[1]))) / 100.0
            return "OK SPEED %d" % int(S.speed * 100)
        if c == "SOLID":
            S.solid = (int(p[1]) & 255, int(p[2]) & 255, int(p[3]) & 255)
            S.mode = "solid"
            return "OK SOLID"
        if c == "OFF":
            S.solid = (0, 0, 0)
            S.mode = "solid"
            return "OK OFF"
        if c == "PLAY":
            S.mode = "play"
            S.reload = True
            return "OK PLAY"
        if c == "DELETE":
            name = line.split(None, 1)[1].strip()
            if name == S.file:
                return "ERR in-use"
            try:
                os.remove(name)
                return "OK DELETE " + name
            except OSError:
                return "ERR no-file"
        return "ERR unknown"
    except (IndexError, ValueError):
        return "ERR args"


def _start_ble():
    # Nordic UART Service peripheral. One text command per write to RX; the
    # reply comes back as a notification on TX. Only present on the Pico W.
    import bluetooth
    import struct

    _IRQ_CONNECT = 1
    _IRQ_DISCONNECT = 2
    _IRQ_WRITE = 3
    _WRITE = bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE
    _NOTIFY = bluetooth.FLAG_NOTIFY
    # Custom service UUID = how the app identifies our devices in a scan. The
    # RX/TX characteristics reuse the Nordic UART UUIDs so generic BLE-UART
    # tools still present a console.
    _SVC = bluetooth.UUID("4C454441-0001-4000-8000-4C4544415254")
    _RX = (bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"), _WRITE)
    _TX = (bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"), _NOTIFY)

    ble = bluetooth.BLE()
    ble.active(True)
    try:
        ble.config(gap_name=S.name)
    except Exception:
        pass
    S.ble = ble
    ((tx, rx),) = ble.gatts_register_services(((_SVC, (_TX, _RX)),))
    ble.gatts_set_buffer(rx, 200)   # room for longer commands (SELECT <name>)
    conns = set()

    def field(t, v):
        return struct.pack("BB", len(v) + 1, t) + v

    def advertise():
        # Service UUID in the advertisement so central scan-filters (iOS) match
        # reliably; the user-settable name rides the scan response.
        adv_data = field(0x01, bytes((6,))) + field(0x07, bytes(_SVC))
        rsp = field(0x09, S.name.encode()[:26])
        ble.gap_advertise(500000, adv_data=adv_data, resp_data=rsp)

    def irq(event, data):
        if event == _IRQ_CONNECT:
            conn, _, _ = data
            conns.add(conn)
        elif event == _IRQ_DISCONNECT:
            conn, _, _ = data
            conns.discard(conn)
            advertise()
        elif event == _IRQ_WRITE:
            conn, handle = data
            if handle == rx:
                try:
                    reply = dispatch(ble.gatts_read(rx).decode())
                except Exception as e:
                    reply = "ERR " + str(e)
                if reply:
                    for c in conns:
                        try:
                            ble.gatts_notify(c, tx, reply.encode())
                        except Exception:
                            pass

    ble.irq(irq)
    advertise()
    return ble


def main():
    S.name = _load_name()
    S.file = _load_current()
    try:
        _start_ble()
        print("BLE control active:", S.name)
    except Exception as e:
        print("BLE unavailable:", e)

    f = None
    frames = 0
    base_delay = 0.03
    while True:
        if S.mode == "solid":
            _show_solid(S.solid, S.n)
            time.sleep_ms(40)
            continue
        if S.reload or f is None:
            if f:
                f.close()
                f = None
            try:
                f = open(S.file, "rb")
            except OSError:
                S.mode = "solid"
                S.solid = (0, 0, 0)
                time.sleep_ms(200)
                continue
            h = f.read(16)
            if h[0:4] != b"LEDA":
                f.close()
                f = None
                S.mode = "solid"
                S.solid = (0, 0, 0)
                time.sleep_ms(200)
                continue
            S.n = h[6] | (h[7] << 8)
            frames = h[8] | (h[9] << 8) | (h[10] << 16) | (h[11] << 24)
            fps = h[12] | (h[13] << 8)
            base_delay = 1.0 / fps if fps else 0.03
            S.reload = False
            print("playing", S.file, "leds", S.n, "frames", frames, "fps", fps)
        fb = S.n * 3
        f.seek(16)
        for _ in range(frames):
            if S.reload or S.mode != "play":
                break
            _show_grb(f.read(fb), S.n)
            time.sleep(base_delay / S.speed if S.speed > 0 else base_delay)


main()
`
}

export function rp2040Readme(pin: number): string {
  return `LED Animator - RP2040 / Pico W (MicroPython) export

Files:
  main.py       WS2812 player (PIO) + BLE control. DATA_PIN is set to GP${pin}.
  pattern.bin   The baked animation (LEDA v1).
  project.json  Editable project - re-import into LED Animator to keep editing.
                (App only; do NOT copy this to the board.)

Install (Thonny or mpremote):
  1. Flash MicroPython for RP2040 onto the Pico / Pico W.
  2. Copy main.py and pattern.bin to the board.
  3. Reset - main.py runs on boot and loops the animation.

Wiring:
  Strip DIN -> GP${pin}; GND common; 5V from an adequate supply.

Bluetooth control (Pico W only):
  main.py advertises a custom LED Animator service (with UART-style
  characteristics). An app finds our devices by filtering scans on the service
  UUID below - the device name is user-settable, so it can't be the identifier.
  Any BLE UART app (nRF Connect, LightBlue) can still connect and drive it.
  Send one text command per write to the RX characteristic; replies come back
  as notifications on TX.
    Service      4C454441-0001-4000-8000-4C4544415254  (unique to LED Animator)
    RX (write)   6E400002-B5A3-F393-E0A9-E50E24DCCA9E
    TX (notify)  6E400003-B5A3-F393-E0A9-E50E24DCCA9E
  Commands:
    PING                 -> OK
    INFO                 -> file, LED count, mode, brightness%, speed%
    LIST                 -> comma-separated .bin pattern files on the board
    FREE                 -> free filesystem bytes
    SELECT <name>        -> play a different pattern file (remembered on reboot)
    BRIGHT <0-100>       -> master brightness percent
    SPEED <10-400>       -> playback speed percent (100 = as authored)
    SOLID <r> <g> <b>    -> hold a solid color (0-255 each)
    OFF                  -> blank the strip
    PLAY                 -> resume the selected pattern
    DELETE <name>        -> remove a pattern file (not the active one)
    NAME                 -> report the current advertised name
    NAME <new name>      -> rename the device (saved to device.name, survives reboot)
  The advertised name defaults to what you set at export time; renaming over BLE
  overrides it. On a plain Pico (no radio) the BLE half is skipped and playback
  still runs.

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

The player steps one frame every 1/fps seconds, looping. The command handler
(dispatch) is transport-agnostic, so the same command set will back Wi-Fi/HTTP
and USB-serial control as those are added.
`
}
