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
LOCK_TOL = 2.0     # |drift| under this (frames) = LOCKED
KP = 0.25          # PLL phase gain (fraction of error corrected per beacon)
KI = 0.03          # PLL rate gain (frames/s of rate per frame of error, per beacon)
R_MIN, R_MAX = 1.0, 240.0
OFF_DECAY = 2.0    # clock-offset filter decay, ms/s (tracks crystal skew, rejects noise)


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

    # PLL state: a virtual "leader clock" — a phase (frame) advancing at rate R.
    phase = 0.0            # current displayed frame (float)
    R = FPS               # rate (frames/sec); the PLL's integral term tunes it
    nf = NUMFRAMES        # loop length, auto-detected from a wrap
    off = None            # clock offset (leader_ms - local_ms), max-filtered
    seeded = False
    local_prev = time.monotonic()
    last_beacon = last_draw = last_print = 0.0
    drift = 0.0
    prev_frame = prev_ts = None
    st = {'group': 0, 'local': 0, 'lframe': 0, 'program': 0, 'bright_pct': 0, 'playing': False,
          'lfps': FPS, 'nf': nf, 'bcount': 0, 'rssi': 0, 'locked': False, 'searching': True, 'drift': 0.0}

    while True:
        now = time.monotonic()
        nowms = now * 1000.0
        dt = now - local_prev
        local_prev = now
        if st['playing']:
            phase = (phase + dt * R) % nf   # free-run at the current estimated rate

        try:
            b = decode_advert(hci.s.recv(258))
            if b and b['kind'] == 'beacon':
                last_beacon = now
                st['bcount'] += 1
                st.update(group=b['group'], program=b['program'], rssi=b['rssi'], lframe=b['frame'],
                          bright_pct=round(b['bright'] / 255 * 100), playing=bool(b['flags'] & 1))

                # Clock offset: max of (leader_ts - local) rejects packet-age noise
                # (older packets read lower), slow decay tracks crystal skew.
                osamp = b['ts'] - nowms
                off = osamp if off is None else max(osamp, off - OFF_DECAY * dt)

                # Rate seed + loop-length detection from consecutive beacons.
                if prev_frame is not None:
                    dts = (b['ts'] - prev_ts)
                    if 0 < dts < 5000:
                        if b['frame'] >= prev_frame:
                            dfr = b['frame'] - prev_frame
                        else:  # wrapped: nf = prev - now + (frames elapsed ~= R*dt)
                            nf_est = int(round(prev_frame - b['frame'] + R * dts / 1000.0))
                            if 10 < nf_est < 100000:
                                nf = nf_est
                            dfr = b['frame'] + nf - prev_frame
                        meas = dfr / (dts / 1000.0)
                        if 1 < meas < 240 and not seeded:
                            R = meas   # seed once for a fast initial lock
                            seeded = True
                prev_frame, prev_ts = b['frame'], b['ts']

                # Predict the leader's CURRENT frame: its frame at ts_leader, plus
                # what it has advanced since (age = leader-time-now - ts_leader).
                age = max(0.0, nowms + off - b['ts'])
                target = (b['frame'] + R * age / 1000.0) % nf
                if not st['playing']:
                    phase = target
                else:
                    drift = wrap_err(target, phase, nf)
                    if abs(drift) > nf * 0.3:      # big jump (restart / new program): resync
                        phase = target
                    else:                          # PLL: correct phase (P) and rate (I)
                        phase = (phase + KP * drift) % nf
                        R = min(R_MAX, max(R_MIN, R + KI * drift))
                st['lfps'] = R
        except socket.timeout:
            pass

        st['local'] = phase % nf
        st['drift'] = drift
        st['nf'] = nf
        st['searching'] = (now - last_beacon) > 1.0 or st['bcount'] == 0
        st['locked'] = (not st['searching']) and abs(drift) <= LOCK_TOL

        if now - last_draw > 0.16:
            render(disp, st)
            last_draw = now
        if now - last_print > 1.0:
            print('phase=%.1f leader=%d drift=%+.2f R=%.2f nf=%d off=%.0f locked=%s beacons=%d'
                  % (phase, st['lframe'], drift, R, nf, (off or 0), st['locked'], st['bcount']))
            sys.stdout.flush()
            last_print = now


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
