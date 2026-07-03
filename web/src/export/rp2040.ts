// MicroPython project for the RP2040 / Pico W: a PIO WS2812 driver + a
// fixed-rate player that plays the selected *.leda pattern (LEDA v1; the file is
// named in selected.txt), plus an optional Bluetooth
// LE control channel (a custom LED Animator service with UART-style characteristics)
// for live brightness / speed / solid color / pattern selection. The BLE half is
// skipped automatically on a plain
// Pico (no radio), so the same script runs on both.

/**
 * The player firmware. Contains NO user settings — the data pin, brightness,
 * and device name are read from files on the board (datapin.txt / bright.txt /
 * devicename.txt, see rp2040SettingsFiles). Only the build id is baked in, so
 * the script is identical for every export.
 */
export function rp2040MainPy(build = 'dev'): string {
  return `# main.py - LED Animator player for RP2040 / Pico W (MicroPython)
# Plays *.leda pattern files (LEDA v1) on a WS2812 / NeoPixel strip via PIO, and on a
# Pico W exposes a Bluetooth LE control channel for live control.
#
# The pattern to play is named in selected.txt; if that file is missing or names
# a pattern that isn't on the board, nothing is played (no default is assumed).
#
# Settings live in files, not this script: datapin.txt (GP pin), bright.txt
# (0-100), devicename.txt (BLE name), selected.txt (pattern filename). The
# playback mode + solid color (play/solid/off) persist to state.txt at runtime,
# so what the strip is doing survives a reboot. Wiring: strip data -> that GP pin
# (default GP0), GND common with the strip's supply. Larger strips need an
# external 5V supply (lower brightness / use BLE BRIGHT).
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


def _load_pin():
    try:
        with open("datapin.txt") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return 0


DATA_PIN = _load_pin()
PATTERN_EXT = ".leda"
DEVICE_NAME = "LED Animator"   # default; devicename.txt / NAME command override
FW_VERSION = ${JSON.stringify(build)}   # build identifier (no real release yet)


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
    bright = 1.0             # 0.0 - 1.0; default, overridden by bright.txt
    speed = 1.0              # playback rate multiplier (1.0 = as authored)
    mode = "play"            # "play", "solid", or "off" (restored from state.txt)
    solid = (0, 0, 0)        # current solid color, also restored from state.txt
    file = None              # selected pattern filename; None = nothing to play
    reload = True
    n = 0                    # LED count of the loaded pattern
    name = DEVICE_NAME       # advertised BLE name (overridable at runtime)
    ble = None               # set once BLE is up, so NAME can update gap_name
    bright_dirty = False     # brightness changed, pending a debounced save
    bright_at = 0            # time.ticks_ms() of the last brightness change
    state_dirty = False      # mode/solid changed, pending a debounced save
    state_at = 0             # time.ticks_ms() of the last mode/solid change
    tx = None                # TX characteristic handle (player-loop notifies)
    conns = None             # live set of connected centrals
    list_queue = None        # files left to stream for a LIST (None = idle)
    list_at = 0              # time.ticks_ms() of the last streamed FILE
    list_total = 0           # count announced (LISTLEN) at the start of a stream
    list_header_sent = False


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
        if name.endswith(PATTERN_EXT):
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
        with open("devicename.txt") as fh:
            nm = fh.read().strip()
            if nm:
                return nm
    except OSError:
        pass
    return DEVICE_NAME


def _load_current():
    # The pattern named in selected.txt, if it exists. No fallback: returns None
    # when there's no selected.txt or it names a file that isn't on the board.
    try:
        with open("selected.txt") as fh:
            nm = fh.read().strip()
        if nm and nm in list_patterns():
            return nm
    except OSError:
        pass
    return None


def _load_bright():
    # Restore the last brightness (percent), else the exported default.
    try:
        with open("bright.txt") as fh:
            v = int(fh.read().strip())
        if 0 <= v <= 100:
            return v / 100.0
    except (OSError, ValueError):
        pass
    return S.bright


def _load_state():
    # Restore the last playback mode + solid color from state.txt
    # ("<mode> <r> <g> <b>"), so play/solid/off survives a reboot.
    try:
        with open("state.txt") as fh:
            parts = fh.read().split()
        if parts and parts[0] in ("play", "solid", "off"):
            S.mode = parts[0]
        if len(parts) >= 4:
            S.solid = (int(parts[1]) & 255, int(parts[2]) & 255, int(parts[3]) & 255)
    except (OSError, ValueError):
        pass


def _prime_led_count():
    # Read the selected pattern's LED count so a solid/off restored at boot can
    # cover the whole strip before any pattern frame is played.
    if not S.file:
        return
    try:
        with open(S.file, "rb") as fh:
            h = fh.read(16)
        if h[0:4] == b"LEDA":
            S.n = h[6] | (h[7] << 8)
    except OSError:
        pass


def _mark_state():
    # Flag the mode/solid color as changed; _persist_state writes it out (debounced).
    S.state_dirty = True
    S.state_at = time.ticks_ms()


def _notify(msg):
    # Push an unsolicited notification from the player loop (not the IRQ).
    if not S.ble or not S.conns:
        return
    try:
        data = msg.encode()
    except Exception:
        return
    for c in tuple(S.conns):
        try:
            S.ble.gatts_notify(c, S.tx, data)
        except Exception:
            pass


def _stream_list():
    # Emit one queued filename per call, paced (~30ms) so we don't outrun the
    # BLE link and drop notifications; finish with ENDLIST.
    if S.list_queue is None:
        return
    if time.ticks_diff(time.ticks_ms(), S.list_at) < 30:
        return
    S.list_at = time.ticks_ms()
    if not S.list_header_sent:
        S.list_header_sent = True
        _notify("LISTLEN %d" % S.list_total)
    elif S.list_queue:
        _notify("FILE " + S.list_queue.pop(0))
    else:
        S.list_queue = None
        _notify("ENDLIST")


def _persist_bright():
    # Debounced: write once the brightness has been steady for ~1s, so a slider
    # drag doesn't hammer the flash. Called from the player loop (not the IRQ).
    if S.bright_dirty and time.ticks_diff(time.ticks_ms(), S.bright_at) > 1000:
        S.bright_dirty = False
        pct = int(S.bright * 100)
        try:
            with open("bright.txt", "w") as fh:
                fh.write(str(pct))
        except Exception:
            pass
        _notify("BRIGHT %d" % pct)   # echo the saved value so the app can sync


def _persist_state():
    # Debounced (like brightness): write the mode + solid color once it's been
    # steady for ~1s, so a color-picker drag doesn't hammer the flash.
    if S.state_dirty and time.ticks_diff(time.ticks_ms(), S.state_at) > 1000:
        S.state_dirty = False
        try:
            with open("state.txt", "w") as fh:
                fh.write("%s %d %d %d" % (S.mode, S.solid[0], S.solid[1], S.solid[2]))
        except Exception:
            pass


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
            # <leds> <mode> <bright%> <speed%> <r> <g> <b> <file...>
            # The filename comes LAST because it may contain spaces; every field
            # before it is a single token, so the app parses those positionally
            # and takes the remainder as the name. The solid color lets the app
            # restore its picker on connect.
            return "INFO %d %s %d %d %d %d %d %s" % (
                S.n, S.mode, int(S.bright * 100), int(S.speed * 100),
                S.solid[0], S.solid[1], S.solid[2], S.file or "")
        if c == "VERSION":
            return "VERSION " + FW_VERSION
        if c == "PLATFORM":
            try:
                return "PLATFORM " + os.uname().machine
            except Exception:
                return "PLATFORM unknown"
        if c == "NAME":
            if len(p) < 2:
                return "NAME " + S.name
            new = line.split(None, 1)[1].strip()[:26]
            if not new:
                return "ERR args"
            S.name = new
            try:
                with open("devicename.txt", "w") as fh:
                    fh.write(new)
            except Exception:
                pass
            try:
                S.ble.config(gap_name=new)
            except Exception:
                pass
            return "OK NAME " + new
        if c == "LIST":
            # Streamed by the player loop: "LISTLEN <n>", then one "FILE <name>"
            # per notification, then "ENDLIST". Avoids the single-notification
            # size limit and any delimiter issues with filenames.
            files = list_patterns()
            S.list_queue = files
            S.list_total = len(files)
            S.list_header_sent = False
            return None
        if c == "FREE":
            return "FREE %d" % _free_bytes()
        if c == "SELECT":
            name = line.split(None, 1)[1].strip()
            if name in list_patterns():
                S.file = name
                S.mode = "play"
                S.reload = True
                _mark_state()
                try:
                    with open("selected.txt", "w") as fh:
                        fh.write(name)
                except Exception:
                    pass
                return "OK SELECT " + name
            return "ERR no-file"
        if c == "BRIGHT":
            S.bright = max(0, min(100, int(p[1]))) / 100.0
            S.bright_dirty = True
            S.bright_at = time.ticks_ms()
            return "OK BRIGHT %d" % int(S.bright * 100)
        if c == "SPEED":
            S.speed = max(10, min(400, int(p[1]))) / 100.0
            return "OK SPEED %d" % int(S.speed * 100)
        if c == "SOLID":
            S.solid = (int(p[1]) & 255, int(p[2]) & 255, int(p[3]) & 255)
            S.mode = "solid"
            _mark_state()
            return "OK SOLID"
        if c == "OFF":
            S.solid = (0, 0, 0)
            S.mode = "off"
            _mark_state()
            return "OK OFF"
        if c == "PLAY":
            S.mode = "play"
            S.reload = True
            _mark_state()
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
    S.tx = tx
    S.conns = conns

    def field(t, v):
        return struct.pack("BB", len(v) + 1, t) + v

    def advertise():
        # Service UUID in the advertisement so central scan-filters (iOS) match
        # reliably; the user-settable name rides the scan response. ~100ms
        # interval so discovery and connection initiation are quick (only
        # advertises while disconnected, so it never competes with playback).
        adv_data = field(0x01, bytes((6,))) + field(0x07, bytes(_SVC))
        rsp = field(0x09, S.name.encode()[:26])
        ble.gap_advertise(100000, adv_data=adv_data, resp_data=rsp)

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
    S.bright = _load_bright()
    _load_state()          # restore play/solid/off + the solid color
    _prime_led_count()     # so a restored solid/off covers the strip at boot
    try:
        _start_ble()
        print("BLE control active:", S.name)
    except Exception as e:
        print("BLE unavailable:", e)

    f = None
    frames = 0
    base_delay = 0.03
    while True:
        if S.mode != "play":
            # solid or off - hold the solid color (off is solid black).
            _persist_bright()
            _persist_state()
            _stream_list()
            _show_solid(S.solid, S.n)
            time.sleep_ms(40)
            continue
        if S.file is None:
            # Nothing selected (or the selection is gone): idle without driving
            # the strip. No default pattern is assumed.
            if f:
                f.close()
                f = None
            _persist_bright()
            _persist_state()
            _stream_list()
            time.sleep_ms(100)
            continue
        if S.reload or f is None:
            if f:
                f.close()
                f = None
            try:
                f = open(S.file, "rb")
            except OSError:
                # The selected file vanished - go idle rather than freeze.
                S.file = None
                continue
            h = f.read(16)
            if h[0:4] != b"LEDA":
                # Not a valid pattern - drop it and go idle.
                f.close()
                f = None
                S.file = None
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
            _persist_bright()
            _persist_state()
            _stream_list()
            _show_grb(f.read(fb), S.n)
            time.sleep(base_delay / S.speed if S.speed > 0 else base_delay)


main()
`
}

export function rp2040Readme(pin: number, patternFile: string): string {
  return `LED Animator - RP2040 / Pico W (MicroPython) export

Files:
  main.py         WS2812 player (PIO) + BLE control. No settings baked in.
  ${patternFile}
                  The baked animation (LEDA v1).
  datapin.txt     The GP pin the strip data line is wired to (GP${pin}).
  bright.txt      Startup brightness percent (0-100).
  devicename.txt  BLE device name.
  selected.txt    The pattern file to play on boot (${patternFile}).
  state.txt       Playback mode + solid color, so play/solid/off survives a
                  reboot. Written by the device at runtime (not in this export).
  project.json    Editable project - re-import into LED Animator to keep editing.
                  (App only; do NOT copy this to the board.)

Install (Thonny or mpremote):
  1. Flash MicroPython for RP2040 onto the Pico / Pico W.
  2. Copy every file except project.json to the board.
  3. Reset - main.py runs on boot and loops the animation.

Wiring:
  Strip DIN -> GP${pin} (edit datapin.txt to change); GND common; 5V supply.

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
    INFO                 -> LED count, mode, brightness%, speed%, solid r g b, filename (last; may contain spaces)
    VERSION              -> firmware version
    PLATFORM             -> board/runtime (os.uname().machine)
    LIST                 -> streams "LISTLEN <n>", one "FILE <name>" each, then ENDLIST
    FREE                 -> free filesystem bytes
    SELECT <name>        -> play a different pattern file (remembered on reboot)
    BRIGHT <0-100>       -> master brightness percent (remembered on reboot)
    SPEED <10-400>       -> playback speed percent (100 = as authored)
    SOLID <r> <g> <b>    -> hold a solid color (0-255 each; remembered on reboot)
    OFF                  -> blank the strip (mode "off"; remembered on reboot)
    PLAY                 -> resume the selected pattern
    DELETE <name>        -> remove a pattern file (not the active one)
    NAME                 -> report the current advertised name
    NAME <new name>      -> rename the device (saved to devicename.txt, survives reboot)
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

/**
 * The on-device settings files that main.py reads at boot. These carry what
 * used to be baked into the script, so main.py itself is settings-free.
 * `patternFile` is the exported pattern's filename, written to selected.txt so
 * the board plays it on first boot.
 */
export function rp2040SettingsFiles(
  pin: number,
  brightness: number,
  name: string,
  patternFile: string,
): Record<string, string> {
  return {
    'datapin.txt': String(pin),
    'bright.txt': String(Math.round(brightness * 100)),
    'devicename.txt': name,
    'selected.txt': patternFile,
  }
}
