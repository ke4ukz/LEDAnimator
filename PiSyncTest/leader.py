#!/usr/bin/python3
"""BLE sync LEADER rig: broadcasts a live beacon (frame index + timestamp a few
Hz) and shows the state on the touchscreen with touch controls.

Run with sudo (HCI USER channel needs root); bluetoothd must be stopped and hci0
down/unblocked first. See README.md, or just: sudo ./run-leader.sh"""
import sys
import time
import traceback
from PIL import Image, ImageDraw
from gfx import font, centered
from display import Display
from touch import Touch
import beacon

FPS = 30
NUMFRAMES = 300           # 10 s loop
GROUP = 0                 # sync group id (u8)
BEACON_HZ = 10
DRAW_HZ = 6


def row_rects(n, y0, y1, w=480, margin=8, gap=6):
    bw = (w - margin * 2 - gap * (n - 1)) / n
    out, x = [], margin
    for _ in range(n):
        out.append((round(x), y0, round(x + bw), y1))
        x += bw + gap
    return out


BTN_ACTIONS = ['playpause', 'prog_dn', 'prog_up', 'brt_dn', 'brt_up']
BTN_RECTS = row_rects(len(BTN_ACTIONS), 250, 312)


def hit(pt):
    if not pt:
        return None
    x, y = pt
    for i, (x0, y0, x1, y1) in enumerate(BTN_RECTS):
        if x0 <= x <= x1 and y0 <= y <= y1:
            return i
    return None


class State:
    playing = True
    program = 7
    bright = 255
    frame_f = 0.0
    seq = 0


def build_frame(st, under):
    """Compose the leader screen as a 480x320 image (no hardware needed)."""
    img = Image.new('RGB', (480, 320), (8, 14, 30))
    d = ImageDraw.Draw(img)
    d.text((12, 6), 'LEADER', font=font(30), fill=(120, 230, 140))
    d.ellipse((300, 15, 312, 27), fill=(90, 200, 255))
    d.text((318, 8), 'BLE', font=font(18), fill=(150, 200, 240))
    d.text((392, 8), f'grp {GROUP}', font=font(16), fill=(170, 180, 200))

    centered(d, (0, 40, 480, 138), f'{int(st.frame_f):04d}', font(76), (235, 240, 255))
    d.text((330, 104), f'/{NUMFRAMES}', font=font(18), fill=(120, 130, 150))

    pct = round(st.bright / 255 * 100)
    d.text((14, 150), f'prog {st.program:02d}     {FPS} fps     bright {pct}%',
           font=font(20), fill=(180, 190, 210))
    playing_col = (120, 230, 140) if st.playing else (240, 200, 90)
    d.text((14, 182), 'PLAYING' if st.playing else 'PAUSED', font=font(22), fill=playing_col)
    d.text((160, 186), f'seq {st.seq:3d}', font=font(16, bold=False), fill=(120, 130, 150))

    labels = ['PAUSE' if st.playing else 'PLAY', 'PROG -', 'PROG +', 'BRT -', 'BRT +']
    for i, box in enumerate(BTN_RECTS):
        active = i == under
        base = (40, 110, 70) if i == 0 else (55, 60, 78)
        fill = tuple(min(255, int(v * 1.7)) for v in base) if active else base
        d.rounded_rectangle(box, radius=10, fill=fill,
                            outline=(255, 255, 255) if active else (150, 160, 180), width=3 if active else 2)
        centered(d, box, labels[i], font(20), (240, 240, 245))
    return img


def do_action(st, i):
    a = BTN_ACTIONS[i]
    if a == 'playpause':
        st.playing = not st.playing
    elif a == 'prog_dn':
        st.program = max(0, st.program - 1)
    elif a == 'prog_up':
        st.program = min(255, st.program + 1)
    elif a == 'brt_dn':
        st.bright = max(0, st.bright - 16)
    elif a == 'brt_up':
        st.bright = min(255, st.bright + 16)
    print(f'ACTION {a} -> playing={st.playing} program={st.program} bright={st.bright}')
    sys.stdout.flush()


def main():
    disp = Display()
    touch = Touch()
    bc = beacon.Beacon(interval_ms=100)
    st = State()
    print('LEADER running (beacon + screen)')
    sys.stdout.flush()

    prev = time.monotonic()
    last_beacon = last_draw = last_seen = 0.0
    touching = False

    try:
        while True:
            now = time.monotonic()
            dt = now - prev
            prev = now
            if st.playing:
                st.frame_f = (st.frame_f + dt * FPS) % NUMFRAMES

            pt = touch.read()
            under = hit(pt)
            if pt:
                last_seen = now
                if not touching:
                    touching = True
                    if under is not None:
                        do_action(st, under)
            elif touching and (now - last_seen) > 0.08:
                touching = False

            if now - last_beacon >= 1.0 / BEACON_HZ:
                ts = int(now * 1000) & 0xFFFFFFFF
                flags = 0x01 if st.playing else 0x00
                bc.update(beacon.pack_payload(GROUP, int(st.frame_f), ts, st.program, st.bright, flags, st.seq))
                st.seq = (st.seq + 1) & 0xFF
                last_beacon = now

            if now - last_draw >= 1.0 / DRAW_HZ:
                disp.show(build_frame(st, under if touching else None))
                last_draw = now

            time.sleep(0.005)
    finally:
        bc.stop()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
