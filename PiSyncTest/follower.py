#!/usr/bin/python3
"""Pi FOLLOWER rig: scans for a leader's sync beacon, phase-locks a free-running
frame counter to it, and shows sync status on the LCD. It's the bench version of
the Pico follower (validate the lock loop here, then port to firmware).

Run with sudo (HCI USER channel); bluetoothd stopped + hci0 down (run-follower.sh).
FPS/NUMFRAMES default 30/300 — pass the leader's pattern values to match:
    python3 follower.py [fps] [numframes]
"""
import socket
import sys
import time
import traceback
from PIL import Image, ImageDraw
from gfx import font, centered
from display import Display
from scanner import open_scanner, decode_advert

FPS = float(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].replace('.', '').isdigit() else 30.0
NUMFRAMES = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 300
LOCK_TOL = 4.0     # |drift| under this (frames) = LOCKED
SNAP_TOL = 25.0    # |drift| over this = hard resync
GAIN = 0.15        # proportional nudge toward the leader per beacon


def wrap_err(target, local, n):
    e = (target - local) % n
    return e - n if e > n / 2 else e


def render(disp, st):
    img = Image.new('RGB', (480, 320), (8, 14, 30))
    d = ImageDraw.Draw(img)
    d.text((12, 6), 'FOLLOWER', font=font(30), fill=(120, 200, 255))
    d.text((392, 8), f'grp {st["group"]}', font=font(16), fill=(170, 180, 200))
    centered(d, (0, 40, 480, 138), f'{int(st["local"]):04d}', font(74), (235, 240, 255))
    d.text((330, 104), f'/{st["nf"]}', font=font(18), fill=(120, 130, 150))

    if st['locked']:
        d.text((14, 150), 'LOCKED', font=font(24), fill=(120, 230, 140))
    elif st['searching']:
        d.text((14, 150), 'SEARCHING', font=font(24), fill=(240, 120, 90))
    else:
        d.text((14, 150), 'ACQUIRING', font=font(24), fill=(240, 200, 90))
    d.text((190, 154), f'drift {st["drift"]:+.1f}f', font=font(20), fill=(200, 200, 210))

    d.text((14, 186), f'leader {st["lframe"]}   prog {st["program"]}   {st["bright_pct"]}%   '
           f'{"play" if st["playing"] else "pause"}', font=font(18), fill=(180, 190, 210))
    d.text((14, 214), f'{st["lfps"]:.1f}fps  nf {st["nf"]}  beacons {st["bcount"]}  rssi {st["rssi"]}',
           font=font(16, bold=False), fill=(120, 130, 150))
    disp.show(img)


def main():
    disp = Display()
    hci = open_scanner(timeout=0.02)  # short timeout so the loop free-runs between adverts
    print(f'follower running (initial fps={FPS} numframes={NUMFRAMES}; both auto-adapt)')
    sys.stdout.flush()

    fps_est = FPS          # adapts to the measured leader rate
    nf = NUMFRAMES         # auto-detected from a wrap
    local = 0.0
    prev = time.monotonic()
    last_beacon = last_draw = last_print = 0.0
    drift = 0.0
    prev_frame = prev_ts = None
    st = {'group': 0, 'local': 0, 'lframe': 0, 'program': 0, 'bright_pct': 0, 'playing': False,
          'lfps': FPS, 'nf': nf, 'bcount': 0, 'rssi': 0, 'locked': False, 'searching': True, 'drift': 0.0}

    while True:
        now = time.monotonic()
        dt = now - prev
        prev = now
        if st['playing']:
            local = (local + dt * fps_est) % nf

        try:
            b = decode_advert(hci.s.recv(258))
            if b and b['kind'] == 'beacon':
                last_beacon = now
                st['bcount'] += 1
                st.update(group=b['group'], program=b['program'], rssi=b['rssi'], lframe=b['frame'],
                          bright_pct=round(b['bright'] / 255 * 100), playing=bool(b['flags'] & 1))

                # Measure the leader's rate; on a wrap, solve for the loop length.
                if prev_frame is not None:
                    dts = (b['ts'] - prev_ts) & 0xFFFFFFFF
                    if 0 < dts < 5000:
                        if b['frame'] >= prev_frame:
                            dfr = b['frame'] - prev_frame
                        else:  # wrapped: true frames elapsed ~= rate*dt, so nf = prev - now + elapsed
                            elapsed = fps_est * dts / 1000.0
                            nf_est = int(round(prev_frame - b['frame'] + elapsed))
                            if 10 < nf_est < 100000:
                                nf = nf_est
                            dfr = b['frame'] + nf - prev_frame
                        inst = dfr / (dts / 1000.0)
                        if 1 < inst < 240:
                            fps_est = 0.85 * fps_est + 0.15 * inst
                            st['lfps'] = fps_est
                prev_frame, prev_ts = b['frame'], b['ts']

                lf = b['frame'] % nf
                drift = wrap_err(lf, local % nf, nf)
                if not st['playing']:
                    local = lf                         # paused: mirror the leader's frame
                elif abs(drift) > SNAP_TOL:
                    local = lf                         # too far off: hard resync
                else:
                    local = (local + drift * GAIN) % nf  # gentle phase-lock
        except socket.timeout:
            pass

        st['local'] = local % nf
        st['drift'] = drift
        st['nf'] = nf
        st['searching'] = (now - last_beacon) > 1.0 or st['bcount'] == 0
        st['locked'] = (not st['searching']) and abs(drift) <= LOCK_TOL

        if now - last_draw > 0.16:
            render(disp, st)
            last_draw = now
        if now - last_print > 1.0:
            print('local=%.0f leader=%d drift=%+.1f fps=%.1f nf=%d locked=%s search=%s beacons=%d'
                  % (local, st['lframe'], drift, fps_est, nf, st['locked'], st['searching'], st['bcount']))
            sys.stdout.flush()
            last_print = now


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
