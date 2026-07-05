#!/usr/bin/python3
"""Shared drawing helpers for the rig UI."""
from PIL import ImageFont


def font(sz, bold=True):
    """A font at size `sz`. Prefers system DejaVu (crisp, has bold); falls back
    to Pillow's bundled scalable default so the rig works with no font package."""
    name = 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'
    try:
        return ImageFont.truetype(f'/usr/share/fonts/truetype/dejavu/{name}', sz)
    except Exception:
        pass
    try:
        return ImageFont.load_default(size=sz)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


def centered(draw, box, text, f, fill):
    """Draw `text` centered inside `box` = (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    tb = draw.textbbox((0, 0), text, font=f)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    draw.text((x0 + (x1 - x0 - tw) / 2, y0 + (y1 - y0 - th) / 2 - tb[1]), text, font=f, fill=fill)
