#!/usr/bin/python3
"""Thin display wrapper for the Waveshare 3.5" (F): ST7796S over SPI, landscape
480x320, correct orientation (MADCTL 0xF8). Wraps the vendor st7796 driver but
owns the framebuffer blit so the rig code never touches SPI details."""
import numpy as np
import st7796

MADCTL_LANDSCAPE = 0xF8  # MY|MX|MV|ML|BGR — upright landscape, verified on hardware

WIDTH, HEIGHT = 480, 320


class Display:
    def __init__(self):
        self._d = st7796.st7796()
        self.width = WIDTH
        self.height = HEIGHT

    def show(self, image):
        """Push a 480x320 PIL RGB image to the panel."""
        d = self._d
        img = np.asarray(image)                                      # (320, 480, 3)
        pix = np.zeros((d.width, d.height, 2), dtype=np.uint8)        # (320, 480, 2)
        pix[..., 0] = np.add(np.bitwise_and(img[..., 0], 0xF8), np.right_shift(img[..., 1], 5))
        pix[..., 1] = np.add(np.bitwise_and(np.left_shift(img[..., 1], 3), 0xE0), np.right_shift(img[..., 2], 3))
        buf = pix.tobytes()
        d.command(0x36)
        d.data(MADCTL_LANDSCAPE)
        d.set_windows(0, 0, d.height, d.width, 1)
        d.digital_write(d.GPIO_DC_PIN, True)
        # writebytes2 accepts a bytes buffer and chunks internally — faster than
        # the vendor's list-based path.
        d.SPI.writebytes2(buf)

    def backlight(self, pct):
        self._d.bl_DutyCycle(pct)
