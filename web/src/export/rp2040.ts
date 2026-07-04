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
#   PING | INFO | MOREINFO | LIST | FREE | POWER | SELECT <name> | BRIGHT <0-100> |
#   SPEED <10-400> | SOLID <r> <g> <b> | OFF | PLAY | DELETE <name> |
#   NAME [new name]  (no arg reports it; setting it persists across reboots)
#   PIN [n]  (no arg reports the data GP pin; "PIN <n>" re-points it live + persists)
# INFO is lean control state; MOREINFO carries version/leds/free/MACs/platform/power.
# POWER -> "POWER usb|batt|unknown <mv>" (VSYS millivolts; 0 = unavailable).
# Once on Wi-Fi, the SAME text commands are accepted over a plain TCP socket on
# port 4550 (newline-terminated), e.g.  nc <device-ip> 4550  then type PING.
# Wi-Fi provisioning (Pico W): WIFISCAN (streams nearby SSIDs), WIFISSID <ssid>,
#   WIFIPASS <password>, WIFICONNECT (joins + saves to networks.txt, auto-joins
#   on boot), WIFISTATUS, WIFIFORGET. Status arrives async as "WIFI <state> <ip>".

import array, time, os
from machine import Pin, ADC
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
CONTROL_PORT = 4550            # TCP port for the (same) text control protocol over Wi-Fi
# The CYW43's first connect after boot can return a spurious BADAUTH
# ("wrong-password") even with correct credentials, so retry a few times (with a
# short backoff) before reporting failure.
WIFI_MAX_RETRIES = 4
WIFI_RETRY_MS = 800


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
    uploading = False        # a TCP client is streaming a pattern file -> pause playback
    n = 0                    # LED count of the loaded pattern
    name = DEVICE_NAME       # advertised BLE name (overridable at runtime)
    device_id = b""          # last 3 bytes of the Wi-Fi MAC (= hostname suffix),
                             # advertised so the app correlates BLE <-> Wi-Fi
    ble = None               # set once BLE is up, so NAME can update gap_name
    bright_dirty = False     # brightness changed, pending a debounced save
    bright_at = 0            # time.ticks_ms() of the last brightness change
    speed_dirty = False      # speed changed, pending a debounced broadcast echo
    speed_at = 0             # time.ticks_ms() of the last speed change
    state_dirty = False      # mode/solid changed, pending a debounced save
    state_at = 0             # time.ticks_ms() of the last mode/solid change
    tx = None                # TX characteristic handle (player-loop notifies)
    conns = None             # live set of connected centrals
    list_queue = None        # files left to stream for a LIST (None = idle)
    list_at = 0              # time.ticks_ms() of the last streamed FILE
    list_total = 0           # count announced (LISTLEN) at the start of a stream
    list_header_sent = False
    list_dest = None         # who asked for the LIST (route the stream back only there)
    scan_dest = None         # who asked for the WIFISCAN
    out_dest = None          # who asked for the MOREINFO batch
    # Wi-Fi (Pico W) - station interface + provisioning. All guarded so a plain
    # Pico (no radio) just skips it.
    wlan = None              # network.WLAN(STA_IF), created + activated lazily
    wifi_state = "off"       # off / connecting / connected / failed
    wifi_ip = ""             # IP when connected, or a short reason when failed
    wifi_ssid = ""           # credentials stashed by WIFISSID, used by WIFICONNECT
    wifi_pass = ""
    wifi_connect_req = False  # player loop should (re)start a connection
    wifi_last_status = None   # last wlan.status() reported (change detection)
    wifi_retries = 0          # auto-retries used for the current connect attempt
    wifi_retry_at = 0         # time.ticks_ms() to fire a scheduled retry (0 = none)
    scan_queue = None        # networks left to stream for a WIFISCAN (None = idle)
    scan_at = 0              # time.ticks_ms() of the last streamed WIFINET
    scan_total = 0
    scan_header_sent = False
    scan_req = False         # player loop should run a (blocking) scan
    out_queue = None         # generic labeled replies to stream paced (MOREINFO)
    out_at = 0               # time.ticks_ms() of the last streamed out_queue line
    tcp_srv = None           # listening socket (once Wi-Fi is up); None = no server
    tcp_clients = []         # list of [sock, buf] - one per connected TCP client
    udp_sock = None          # UDP discovery socket (replies to LEDADISCOVER probes)


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


def _set_pin(arg):
    # Re-point the WS2812 output at a new GP pin at runtime and persist it, so a
    # single prebuilt firmware works for any wiring (no per-device UF2 needed).
    global DATA_PIN, sm
    try:
        n = int(arg)
    except (ValueError, TypeError):
        return "ERR pin"
    if n < 0 or n > 29:
        return "ERR pin"
    try:
        sm.active(0)
        sm = rp2.StateMachine(0, ws2812, freq=8_000_000, sideset_base=Pin(n))
        sm.active(1)
    except Exception:
        return "ERR pin"
    DATA_PIN = n
    S.reload = True   # re-render the current frame on the new pin
    try:
        with open("datapin.txt", "w") as fh:
            fh.write(str(DATA_PIN))
    except Exception:
        pass
    return "OK PIN %d" % DATA_PIN


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


def _send_to(origin, msg):
    # Send one line to a SINGLE client (the one that made a request), not a
    # broadcast. origin is ("ble", conn) or ("tcp", None); None falls back to a
    # broadcast. Used for request-responses (LIST / WIFISCAN / MOREINFO streams)
    # so other connected clients don't receive replies they never asked for.
    if origin is None:
        _notify(msg)
        return
    kind, ref = origin
    if kind == "tcp":
        _tcp_send_one(ref, msg + "\\n")
    elif S.ble is not None:
        try:
            S.ble.gatts_notify(ref, S.tx, msg.encode())
        except Exception:
            pass


def _notify(msg):
    # BROADCAST an unsolicited line to every connected control transport - BLE
    # notifies (message-framed, no newline) and every TCP client (newline-added).
    # For genuine shared-state changes (BRIGHT / SPEED echoes, WIFI status) that
    # every client should see. Called from the player loop (not the IRQ).
    if S.ble and S.conns:
        try:
            data = msg.encode()
            for c in tuple(S.conns):
                try:
                    S.ble.gatts_notify(c, S.tx, data)
                except Exception:
                    pass
        except Exception:
            pass
    if S.tcp_clients:
        line = msg + "\\n"
        for entry in list(S.tcp_clients):
            _tcp_send_one(entry[0], line)


def _broadcast_list():
    # Push a fresh pattern list to ALL clients (after an upload/delete changes the
    # files), so every connected app stays current. dest=None -> _send_to
    # broadcasts; the app resets its list when it sees LISTLEN.
    S.list_queue = list_patterns()
    S.list_total = len(S.list_queue)
    S.list_header_sent = False
    S.list_dest = None


def _stream_list():
    # Emit one queued filename per call, paced (~30ms) so we don't outrun the
    # BLE link and drop notifications; finish with ENDLIST. Routed to the client
    # that asked (S.list_dest), or broadcast when dest is None (after a change).
    if S.list_queue is None:
        return
    if time.ticks_diff(time.ticks_ms(), S.list_at) < 30:
        return
    S.list_at = time.ticks_ms()
    if not S.list_header_sent:
        S.list_header_sent = True
        _send_to(S.list_dest, "LISTLEN %d" % S.list_total)
    elif S.list_queue:
        _send_to(S.list_dest, "FILE " + S.list_queue.pop(0))
    else:
        S.list_queue = None
        _send_to(S.list_dest, "ENDLIST")


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


def _echo_speed():
    # Debounced like brightness (but no flash write - speed isn't persisted):
    # once speed has been steady ~1s, broadcast it so other clients stay in sync.
    if S.speed_dirty and time.ticks_diff(time.ticks_ms(), S.speed_at) > 1000:
        S.speed_dirty = False
        _notify("SPEED %d" % int(S.speed * 100))


def _state_line():
    # The lean control state, as INFO. Returned by the INFO command AND broadcast
    # on change (below) so every client stays in sync. <mode> <bright%> <speed%>
    # <r> <g> <b> <file...> - filename last so a spaced name survives.
    return "INFO %s %d %d %d %d %d %s" % (
        S.mode, int(S.bright * 100), int(S.speed * 100),
        S.solid[0], S.solid[1], S.solid[2], S.file or "")


def _persist_state():
    # Debounced (like brightness): write the mode + solid color once it's been
    # steady for ~1s, so a color-picker drag doesn't hammer the flash. Also
    # broadcasts the new state so OTHER clients sync (SELECT / SOLID / OFF / PLAY,
    # which otherwise only ack the client that sent them).
    if S.state_dirty and time.ticks_diff(time.ticks_ms(), S.state_at) > 1000:
        S.state_dirty = False
        try:
            with open("state.txt", "w") as fh:
                fh.write("%s %d %d %d" % (S.mode, S.solid[0], S.solid[1], S.solid[2]))
        except Exception:
            pass
        _notify(_state_line())


# ---- Wi-Fi (Pico W) --------------------------------------------------------
# Provisioning + status only: set credentials over BLE, join, report the IP
# back over BLE. NO HTTP yet. The station interface shares the CYW43 radio with
# BLE, so everything here is guarded and never raises into the player loop; a
# plain Pico (no radio) simply reports "off". The actual join runs in the player
# loop (not the IRQ), polled non-blocking between frames so playback keeps going.

def _wifi_iface():
    # Lazily create + activate the station interface. Returns None if there's no
    # wireless (plain Pico) or activation fails.
    if S.wlan is None:
        try:
            import network
            S.wlan = network.WLAN(network.STA_IF)
        except Exception:
            return None
    try:
        if not S.wlan.active():
            S.wlan.active(True)
    except Exception:
        return None
    return S.wlan


def _wifi_status_str():
    # "WIFI <state> <detail>" - detail is the IP when connected, a short reason
    # when failed, else empty. State + detail are each a single token.
    return "WIFI %s %s" % (S.wifi_state, S.wifi_ip)


def _wifi_hostname():
    # DHCP/mDNS hostname = sanitized device name + "-" + last 6 hex of the MAC.
    # The MAC suffix keeps two devices with the same friendly name distinct on
    # the network. The device name is already <=26 chars, so length is not a
    # concern (hostname labels allow up to 63).
    base = ""
    prev_hyphen = False
    for ch in S.name:
        if ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9"):
            base += ch
            prev_hyphen = False
        elif not prev_hyphen:   # collapse any run of other chars to one hyphen
            base += "-"
            prev_hyphen = True
    base = base.strip("-")
    if not base:
        base = "led-animator"
    try:
        mac = S.wlan.config("mac")
        base += "-%02X%02X%02X" % (mac[-3], mac[-2], mac[-1])
    except Exception:
        pass
    return base


def _fmt_mac(raw):
    return ":".join("%02X" % b for b in raw)


def _wifi_mac():
    # The station MAC. Creates the WLAN object if needed (doesn't activate the
    # radio just to read it). Empty on a plain Pico with no wireless.
    try:
        if S.wlan is None:
            import network
            S.wlan = network.WLAN(network.STA_IF)
        return _fmt_mac(S.wlan.config("mac"))
    except Exception:
        return ""


def _ble_mac():
    try:
        _, addr = S.ble.config("mac")
        return _fmt_mac(addr)
    except Exception:
        return ""


def _device_id_bytes():
    # Last 3 bytes of the Wi-Fi (STA) MAC - same bytes the hostname suffix uses -
    # so the app can match this BLE device to its Wi-Fi discovery. b"" if no radio.
    try:
        if S.wlan is None:
            import network
            S.wlan = network.WLAN(network.STA_IF)
        return bytes(S.wlan.config("mac")[-3:])
    except Exception:
        return b""


def _load_networks():
    # networks.txt: line 1 = SSID, line 2 = password. Auto-connect on boot.
    try:
        with open("networks.txt") as fh:
            lines = fh.read().split("\\n")
    except OSError:
        return
    ssid = lines[0].strip() if lines else ""
    if ssid:
        S.wifi_ssid = ssid
        # Strip trailing CR/LF only (not spaces), in case the file picked up
        # Windows line endings; a real password won't end in a control character.
        S.wifi_pass = (lines[1] if len(lines) > 1 else "").rstrip("\\r\\n")
        S.wifi_connect_req = True


def _save_networks():
    try:
        with open("networks.txt", "w") as fh:
            fh.write(S.wifi_ssid + "\\n" + S.wifi_pass)
    except Exception:
        pass


def _begin_connect():
    wl = _wifi_iface()
    if wl is None:
        S.wifi_state = "off"
        S.wifi_ip = ""
        _notify(_wifi_status_str())
        return
    S.wifi_state = "connecting"
    S.wifi_ip = ""
    S.wifi_last_status = None
    try:   # identify ourselves to DHCP/mDNS (before connecting, so it's used)
        import network
        network.hostname(_wifi_hostname())
    except Exception:
        pass
    try:
        wl.connect(S.wifi_ssid, S.wifi_pass)
    except Exception:
        S.wifi_state = "failed"
        S.wifi_ip = "error"
    _notify(_wifi_status_str())


def _poll_wifi():
    # Non-blocking: watch a pending connection and notify when it resolves.
    if S.wifi_state != "connecting" or S.wlan is None:
        return
    try:
        st = S.wlan.status()
    except Exception:
        return
    if st == S.wifi_last_status:
        return
    S.wifi_last_status = st
    try:
        import network
        if st == network.STAT_GOT_IP:
            S.wifi_retries = 0
            S.wifi_state = "connected"
            S.wifi_ip = S.wlan.ifconfig()[0]
            _start_tcp()   # the control port is only reachable once we have an IP
            _start_udp()   # ...and start answering discovery probes
            _notify(_wifi_status_str())
        elif st < 0:   # negative status codes are the error states
            if S.wifi_retries < WIFI_MAX_RETRIES:
                # Likely the spurious first-attempt BADAUTH: schedule a retry and
                # stay "connecting" (don't report failure to the app yet). Leave
                # wifi_last_status = st so we don't re-count until the retry runs.
                S.wifi_retries += 1
                S.wifi_retry_at = time.ticks_ms() + WIFI_RETRY_MS
            else:
                reasons = {network.STAT_WRONG_PASSWORD: "wrong-password",
                           network.STAT_NO_AP_FOUND: "no-ap",
                           network.STAT_CONNECT_FAIL: "failed"}
                S.wifi_state = "failed"
                S.wifi_ip = reasons.get(st, "failed")
                _notify(_wifi_status_str())
    except Exception:
        pass


def _do_scan():
    # Blocking (~2s) - runs from the player loop, so playback pauses briefly.
    # Streams the results afterwards (paced) via _stream_scan.
    wl = _wifi_iface()
    if wl is None:
        _send_to(S.scan_dest, "WIFISCANEND")
        return
    try:
        nets = wl.scan()
    except Exception:
        _send_to(S.scan_dest, "WIFISCANEND")
        return
    seen = []
    out = []
    for net in nets:
        try:
            ssid = net[0].decode()
        except Exception:
            ssid = ""
        if not ssid or ssid in seen:
            continue
        seen.append(ssid)
        out.append((net[3], ssid))   # (RSSI, SSID)
    out.sort(key=lambda x: x[0], reverse=True)   # strongest first
    S.scan_queue = out
    S.scan_total = len(out)
    S.scan_header_sent = False


def _stream_scan():
    # One WIFINET per call (~30ms paced), like the pattern LIST stream. SSID is
    # last on the line, so an SSID with spaces survives.
    if S.scan_queue is None:
        return
    if time.ticks_diff(time.ticks_ms(), S.scan_at) < 30:
        return
    S.scan_at = time.ticks_ms()
    if not S.scan_header_sent:
        S.scan_header_sent = True
        _send_to(S.scan_dest, "WIFISCANLEN %d" % S.scan_total)
    elif S.scan_queue:
        rssi, ssid = S.scan_queue.pop(0)
        _send_to(S.scan_dest, "WIFINET %d %s" % (rssi, ssid))
    else:
        S.scan_queue = None
        _send_to(S.scan_dest, "WIFISCANEND")


def _wifi_step():
    if S.scan_req:
        S.scan_req = False
        _do_scan()
    if S.wifi_connect_req:
        # A fresh connect (boot auto-join or a WIFICONNECT command): reset the
        # retry budget so this attempt gets its own set of retries.
        S.wifi_connect_req = False
        S.wifi_retries = 0
        S.wifi_retry_at = 0
        _begin_connect()
    elif S.wifi_retry_at and time.ticks_diff(time.ticks_ms(), S.wifi_retry_at) >= 0:
        S.wifi_retry_at = 0
        _begin_connect()
    _poll_wifi()


def _stream_out():
    # One queued labeled reply per call (~25ms paced), so a burst (e.g. MOREINFO)
    # never overflows the notify buffer and drops lines.
    if S.out_queue is None:
        return
    if time.ticks_diff(time.ticks_ms(), S.out_at) < 25:
        return
    S.out_at = time.ticks_ms()
    if S.out_queue:
        _send_to(S.out_dest, S.out_queue.pop(0))
    else:
        S.out_queue = None


# ---- TCP control transport (Wi-Fi) -----------------------------------------
# The SAME text protocol as BLE, over plain TCP sockets on CONTROL_PORT. TCP is
# a byte stream (no message boundaries like BLE), so commands are newline-framed
# and buffered per client until a full line arrives; replies are newline-added.
# No HTTP. Several clients at once (phone + Mac ...), each with its own buffer;
# request-responses route back to the requester, shared state broadcasts to all.

MAX_TCP_CLIENTS = 4

def _tcp_send_one(cl, s):
    try:
        cl.send(s.encode())
    except Exception:
        _tcp_drop(cl)


def _tcp_drop(cl):
    try:
        cl.close()
    except Exception:
        pass
    S.tcp_clients = [e for e in S.tcp_clients if e[0] is not cl]


def _start_tcp():
    # Bring up the listening socket once Wi-Fi has an IP. Idempotent.
    if S.tcp_srv is not None:
        return
    try:
        import socket
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", CONTROL_PORT))
        srv.listen(MAX_TCP_CLIENTS)
        srv.setblocking(False)
        S.tcp_srv = srv
        S.tcp_clients = []
        print("TCP control on port", CONTROL_PORT)
    except Exception as e:
        print("TCP server unavailable:", e)
        S.tcp_srv = None


def _stop_tcp():
    for entry in list(S.tcp_clients):
        try:
            entry[0].close()
        except Exception:
            pass
    S.tcp_clients = []
    if S.tcp_srv is not None:
        try:
            S.tcp_srv.close()
        except Exception:
            pass
    S.tcp_srv = None


def _valid_pattern_name(name):
    # Whitelist basic chars (NO path separators), force a .leda extension, cap
    # length, reject the device's own config files. The app sanitizes too.
    keep = ""
    for ch in name:
        if ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9") or ch in " _-.":
            keep += ch
    keep = keep.strip()
    if not keep or keep.startswith(".") or ".." in keep:
        return None
    if not keep.endswith(".leda"):
        keep = keep + ".leda"
    if len(keep) > 40:
        return None
    if keep in ("main.py", "datapin.txt", "bright.txt", "devicename.txt",
                "selected.txt", "state.txt", "networks.txt", "upload.tmp",
                "project.json"):
        return None
    return keep


# UPLOAD is TCP-only (bulk binary). "UPLOAD <len> <name...>" -> "OK UPLOAD",
# then the client streams exactly <len> raw bytes; the device writes them to a
# temp file, checks the LEDA magic, renames to <name>, and replies OK UPLOADED.
# Playback clears + pauses (S.uploading) during the transfer.

def _upload_begin(cl, entry, text):
    try:
        parts = text.split(None, 2)     # ["UPLOAD", "<len>", "<name...>"]
        length = int(parts[1])
        name = _valid_pattern_name(parts[2])
    except Exception:
        _tcp_send_one(cl, "ERR args\\n")
        return
    if not name:
        _tcp_send_one(cl, "ERR name\\n")
        return
    if length <= 0 or length > _free_bytes() - 8192:   # keep some slack free
        _tcp_send_one(cl, "ERR size\\n")
        return
    try:
        fh = open("upload.tmp", "wb")
    except Exception:
        _tcp_send_one(cl, "ERR open\\n")
        return
    entry[2] = [length, fh, name]
    S.uploading = True
    _tcp_send_one(cl, "OK UPLOAD\\n")


def _upload_finish(cl, fh, name):
    try:
        fh.close()
    except Exception:
        pass
    S.uploading = False
    S.reload = True                     # resume playback afterwards
    ok = False
    try:
        with open("upload.tmp", "rb") as f:
            ok = f.read(4) == b"LEDA"
    except Exception:
        pass
    if not ok:
        try:
            os.remove("upload.tmp")
        except Exception:
            pass
        _tcp_send_one(cl, "ERR badfile\\n")
        return
    try:
        try:
            os.remove(name)             # overwrite same-named pattern
        except OSError:
            pass
        os.rename("upload.tmp", name)
        _tcp_send_one(cl, "OK UPLOADED " + name + "\\n")
        _broadcast_list()   # tell every client about the new pattern
    except Exception:
        try:
            os.remove("upload.tmp")
        except Exception:
            pass
        _tcp_send_one(cl, "ERR save\\n")


def _upload_abort(entry):
    up = entry[2]
    entry[2] = None
    if up:
        try:
            up[1].close()
        except Exception:
            pass
    try:
        os.remove("upload.tmp")
    except Exception:
        pass
    S.uploading = False
    S.reload = True


def _tcp_step():
    # Non-blocking: accept any waiting client, then drain each - parsing
    # newline-framed commands, or (during UPLOAD) writing raw bytes to a file.
    if S.tcp_srv is None:
        return
    try:
        cl, _ = S.tcp_srv.accept()
        if len(S.tcp_clients) >= MAX_TCP_CLIENTS:
            cl.close()
        else:
            cl.setblocking(False)
            S.tcp_clients.append([cl, b"", None])   # [sock, buf, upload or None]
    except OSError:
        pass
    for entry in list(S.tcp_clients):
        cl = entry[0]
        try:
            data = cl.recv(1024)
        except OSError as e:
            if e.args[0] in (11, 35):   # EAGAIN - no data right now
                continue
            _tcp_drop(cl)
            continue
        if not data:                    # peer closed
            if entry[2] is not None:
                _upload_abort(entry)
            _tcp_drop(cl)
            continue
        entry[1] += data
        _tcp_drain(entry)


def _tcp_drain(entry):
    cl = entry[0]
    while True:
        if entry[2] is not None:
            # Upload mode: pour buffered bytes into the temp file.
            if not entry[1]:
                return
            remaining, fh, name = entry[2]
            take = remaining if remaining < len(entry[1]) else len(entry[1])
            try:
                fh.write(entry[1][:take])
            except Exception:
                entry[1] = entry[1][take:]
                _upload_abort(entry)
                _tcp_send_one(cl, "ERR write\\n")
                continue
            entry[1] = entry[1][take:]
            remaining -= take
            if remaining > 0:
                entry[2] = [remaining, fh, name]
                return
            entry[2] = None
            _upload_finish(cl, fh, name)
            continue   # any trailing bytes are the next command(s)
        nl = entry[1].find(b"\\n")
        if nl < 0:
            if len(entry[1]) > 512:
                entry[1] = b""          # runaway line with no terminator
            return
        line = entry[1][:nl]
        entry[1] = entry[1][nl + 1:]
        try:
            text = line.decode().strip()
        except Exception:
            continue
        if not text:
            continue
        if text[:7].upper() == "UPLOAD ":
            _upload_begin(cl, entry, text)
            continue
        try:
            reply = dispatch(text, ("tcp", cl))
        except Exception as e:
            reply = "ERR " + str(e)
        if reply:
            _tcp_send_one(cl, reply + "\\n")


# ---- UDP discovery ---------------------------------------------------------
# mDNS isn't reliable on stock Pico W MicroPython, so devices announce
# themselves via a tiny UDP scheme instead: an app broadcasts "LEDADISCOVER" to
# the subnet on CONTROL_PORT and each device replies "LEDA <hostname> <name>"
# (name last, may contain spaces) to the sender, who pairs it with the source IP.

def _start_udp():
    if S.udp_sock is not None:
        return
    try:
        import socket
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        u.bind(("0.0.0.0", CONTROL_PORT))   # receives broadcasts too
        u.setblocking(False)
        S.udp_sock = u
        print("UDP discovery on port", CONTROL_PORT)
    except Exception as e:
        print("UDP discovery unavailable:", e)
        S.udp_sock = None


def _stop_udp():
    if S.udp_sock is not None:
        try:
            S.udp_sock.close()
        except Exception:
            pass
    S.udp_sock = None


def _udp_step():
    if S.udp_sock is None:
        return
    try:
        data, addr = S.udp_sock.recvfrom(64)
    except OSError:
        return   # EAGAIN - nothing waiting
    if data and data.strip().startswith(b"LEDADISCOVER"):
        try:
            S.udp_sock.sendto(("LEDA %s %s" % (_wifi_hostname(), S.name)).encode(), addr)
        except Exception:
            pass


def _tick():
    # Per-loop housekeeping shared by every branch of the player loop.
    _persist_bright()
    _echo_speed()
    _persist_state()
    _stream_list()
    _stream_scan()
    _stream_out()
    _tcp_step()
    _udp_step()
    _wifi_step()


# --- Power sensing (Pico W) --------------------------------------------------
# USB present: WL_GPIO2 on the CYW43 (high = USB power). Battery/VSYS: ADC3 on
# GPIO29 reads VSYS/3. GPIO29 is shared with the wireless SPI clock, so a read
# can glitch while the radio is busy -> median of a few samples, tolerate errors.
# Only sampled on request (POWER / MOREINFO), never in the LED hot loop.
_vbus = None
_vsys = None   # ADC once created, or False if this board has no VSYS ADC


def _power_status():
    global _vbus, _vsys
    try:
        if _vbus is None:
            _vbus = Pin("WL_GPIO2", Pin.IN)
        plugged = bool(_vbus.value())
    except Exception:
        plugged = None   # no CYW43 (not a Pico W) -> can't tell
    mv = 0
    if _vsys is None:
        try:
            _vsys = ADC(29)
        except Exception:
            try:
                _vsys = ADC(3)
            except Exception:
                _vsys = False
    if _vsys:
        try:
            s = sorted(_vsys.read_u16() for _ in range(5))
            mv = int(s[2] * 3.3 * 3 / 65535 * 1000)   # median * VREF * divider
        except Exception:
            mv = 0
    src = "unknown" if plugged is None else ("usb" if plugged else "batt")
    return "POWER %s %d" % (src, mv)   # mv == 0 -> voltage unavailable


def dispatch(line, origin=None):
    # Transport-agnostic command handler. Returns a short direct reply string
    # (sent by the caller to the origin only). Commands that STREAM their reply
    # (LIST / WIFISCAN / MOREINFO) stash the origin so the player loop routes the
    # stream back to just the requester. origin = ("ble", conn) or ("tcp", None).
    line = line.strip()
    if not line:
        return None
    p = line.split()
    c = p[0].upper()
    try:
        if c == "PING":
            return "OK"
        if c == "INFO":
            # Lean, control-only (fetched on every connect). Same line the device
            # broadcasts on state change (see _state_line / _persist_state).
            # Static/rarely-used details (version, LEDs, free, MACs, platform)
            # live in MOREINFO, fetched lazily, so this stays small.
            return _state_line()
        if c == "MOREINFO":
            # Everything the Info tab shows, as a set of DISCRETE labeled
            # notifications (streamed paced by the player loop, like LIST). Each
            # is "KEY <value...>" - self-describing, order-independent, and each
            # value gets its own line so spaces are never a problem. Add fields
            # freely; the app ignores keys it doesn't know.
            try:
                machine = os.uname().machine
            except Exception:
                machine = "unknown"
            fields = [
                "VERSION " + FW_VERSION,
                "LEDS %d" % S.n,
                "FREE %d" % _free_bytes(),
            ]
            wm = _wifi_mac()
            if wm:
                fields.append("WIFIMAC " + wm)
            bm = _ble_mac()
            if bm:
                fields.append("BTMAC " + bm)
            fields.append("HOSTNAME " + _wifi_hostname())
            fields.append("PLATFORM " + machine)
            fields.append("PIN %d" % DATA_PIN)
            fields.append(_power_status())   # "POWER usb|batt|unknown <mv>"
            # A field with no hardware is OMITTED (not sent as a placeholder); the
            # app shows N/A for anything still missing once ENDINFO arrives.
            fields.append("ENDINFO")
            S.out_queue = fields
            S.out_dest = origin
            return None
        if c == "PIN":
            # No arg reports the current data pin; "PIN <n>" re-points the strip
            # output live and persists it (so one prebuilt firmware fits any wiring).
            if len(p) >= 2:
                return _set_pin(p[1])
            return "PIN %d" % DATA_PIN
        if c == "POWER":
            # Live power status, polled by the app while the Info panel is open.
            return _power_status()
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
            # Keep names (which ride the protocol + BLE advert) to printable
            # ASCII only, then trim + cap at 26.
            raw = line.split(None, 1)[1]
            new = "".join(ch for ch in raw if 32 <= ord(ch) < 127).strip()[:26]
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
            S.list_dest = origin
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
            S.speed_dirty = True   # broadcast a debounced echo so other clients sync
            S.speed_at = time.ticks_ms()
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
                _broadcast_list()   # tell every client the pattern is gone
                return "OK DELETE " + name
            except OSError:
                return "ERR no-file"
        # --- Wi-Fi provisioning (Pico W). The heavy work (scan/connect) runs in
        # the player loop; these handlers just stash state and set a request. ---
        if c == "WIFISCAN":
            S.scan_req = True
            S.scan_dest = origin
            return None            # results stream as WIFISCANLEN/WIFINET/WIFISCANEND
        if c == "WIFISSID":
            S.wifi_ssid = line.split(None, 1)[1].strip() if len(p) > 1 else ""
            return "OK WIFISSID"
        if c == "WIFIPASS":
            S.wifi_pass = line.split(None, 1)[1] if len(p) > 1 else ""
            return "OK WIFIPASS"
        if c == "WIFICONNECT":
            if not S.wifi_ssid:
                return "ERR no-ssid"
            _save_networks()
            S.wifi_connect_req = True
            return None            # status arrives async as WIFI <state> <detail>
        if c == "WIFISTATUS":
            return _wifi_status_str()
        if c == "WIFIFORGET":
            S.wifi_ssid = ""
            S.wifi_pass = ""
            try:
                os.remove("networks.txt")
            except OSError:
                pass
            _stop_tcp()
            _stop_udp()
            try:
                if S.wlan:
                    S.wlan.disconnect()
                    S.wlan.active(False)
            except Exception:
                pass
            S.wifi_state = "off"
            S.wifi_ip = ""
            return "OK WIFIFORGET"
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
    S.device_id = _device_id_bytes()   # cached once; advertised for BLE<->Wi-Fi matching

    def field(t, v):
        return struct.pack("BB", len(v) + 1, t) + v

    def advertise():
        # Service UUID in the advertisement so central scan-filters (iOS) match
        # reliably; the user-settable name rides the scan response. ~100ms
        # interval so discovery and connection initiation are quick (only
        # advertises while disconnected, so it never competes with playback).
        adv_data = field(0x01, bytes((6,))) + field(0x07, bytes(_SVC))
        if S.device_id:
            # Manufacturer data: 0xFFFF (no company) + the 3-byte device id, so the
            # app can correlate this device with its Wi-Fi discovery (hostname suffix).
            adv_data += field(0xFF, b"\\xff\\xff" + S.device_id)
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
                    reply = dispatch(ble.gatts_read(rx).decode(), ("ble", conn))
                except Exception as e:
                    reply = "ERR " + str(e)
                if reply:   # direct reply -> only the client that asked
                    try:
                        ble.gatts_notify(conn, tx, reply.encode())
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
    _load_networks()       # queue a Wi-Fi auto-connect if provisioned
    try:
        _start_ble()
        print("BLE control active:", S.name)
    except Exception as e:
        print("BLE unavailable:", e)

    f = None
    frames = 0
    base_delay = 0.03
    while True:
        if S.uploading:
            # A pattern file is streaming in over TCP: close our handle (it may be
            # the file being overwritten), go dark, and keep servicing the socket.
            if f:
                f.close()
                f = None
            _tick()
            _show_solid((0, 0, 0), S.n)
            time.sleep_ms(5)
            continue
        if S.mode != "play":
            # solid or off - hold the solid color (off is solid black).
            _tick()
            _show_solid(S.solid, S.n)
            time.sleep_ms(40)
            continue
        if S.file is None:
            # Nothing selected (or the selection is gone): idle without driving
            # the strip. No default pattern is assumed.
            if f:
                f.close()
                f = None
            _tick()
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
            if S.reload or S.mode != "play" or S.uploading:
                break
            _tick()
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
  networks.txt    Wi-Fi credentials (SSID + password) once provisioned over BLE,
                  so it re-joins on boot. Written at runtime (not in this export).
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
    INFO                 -> mode, brightness%, speed%, solid r g b, filename (last; may contain spaces)
    MOREINFO             -> streams discrete labeled replies "KEY <value>" (VERSION, LEDS, FREE, WIFIMAC, BTMAC, HOSTNAME, PLATFORM, POWER), then ENDINFO. Fields with no hardware are omitted. All values are printable ASCII.
    POWER                -> "POWER usb|batt|unknown <mv>" (VSYS millivolts; 0 = unavailable)
    PIN [n]              -> no arg reports "PIN <n>"; "PIN <n>" re-points the strip output live + persists (OK PIN <n> / ERR pin)
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
    UPLOAD <len> <name>  -> (TCP only) OK UPLOAD, then stream <len> bytes; OK UPLOADED <name>
    NAME                 -> report the current advertised name
    NAME <new name>      -> rename the device (saved to devicename.txt, survives reboot)
    WIFISCAN             -> streams "WIFISCANLEN <n>", one "WIFINET <rssi> <ssid>" each, then WIFISCANEND
    WIFISSID <ssid>      -> stash the network name for the next WIFICONNECT
    WIFIPASS <password>  -> stash the password for the next WIFICONNECT
    WIFICONNECT          -> join with the stashed credentials, save to networks.txt (auto-joins on boot)
    WIFISTATUS           -> "WIFI <state> <detail>" (state = off/connecting/connected/failed; detail = IP or reason)
    WIFIFORGET           -> clear networks.txt and disconnect
  Wi-Fi status is also pushed unsolicited as "WIFI <state> <detail>" when a join
  resolves. The advertised name defaults to what you set at export time; renaming
  over BLE overrides it. On a plain Pico (no radio) the BLE/Wi-Fi halves are
  skipped and playback still runs.

Wi-Fi control (Pico W, once provisioned):
  The SAME text commands are accepted over a plain TCP socket on port 4550,
  one command per line (newline-terminated); each reply is newline-terminated
  too. No HTTP - it's the identical protocol as BLE over a raw socket. Try it:
    nc <device-ip> 4550     then type:  PING   ->  OK
  Streamed replies (LIST / WIFISCAN / MOREINFO) arrive as lines ending in
  ENDLIST / WIFISCANEND / ENDINFO, same as over BLE.
  Discovery (mDNS is unreliable on stock Pico W): broadcast "LEDADISCOVER" as a
  UDP datagram to port 4550 and each device answers "LEDA <hostname> <name>".
  Upload a pattern (TCP only): send "UPLOAD <len> <name>" and wait for
  "OK UPLOAD", then stream exactly <len> raw bytes of a LEDA file; the device
  writes it, verifies the magic, and replies "OK UPLOADED <name>". Playback goes
  dark and pauses during the transfer. Several clients (phone + Mac ...) can be
  connected at once; replies to a request go only to the client that asked.

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
