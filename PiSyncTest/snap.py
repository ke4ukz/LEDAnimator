#!/usr/bin/python3
"""Render the leader screen to /tmp/leader_snap.png without any hardware — for
tweaking the UI over SSH. Usage: python3 snap.py [frame] [--paused]"""
import sys
from leader import build_frame, State

st = State()
st.frame_f = float(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 123.0
if '--paused' in sys.argv:
    st.playing = False
img = build_frame(st, None)
img.save('/tmp/leader_snap.png')
print('wrote /tmp/leader_snap.png', img.size)
