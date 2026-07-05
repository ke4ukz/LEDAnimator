#!/usr/bin/python3
"""GT911 capacitive touch on the Waveshare 3.5" (F), polled over I2C (no
RPi.GPIO). read() returns a single touch point already mapped to landscape
screen coordinates (480x320), or None."""
import time
import smbus2

ADDR_CANDIDATES = [0x5D, 0x14]
REG_ID = 0x8140
REG_STATUS = 0x814E
REG_P1 = 0x8150  # x_low, x_high, y_low, y_high


class Touch:
    def __init__(self, bus_n=1):
        self.bus = smbus2.SMBus(bus_n)
        self.addr = self._detect()
        if self.addr is None:
            self._reset_addr_5d()
            self.addr = self._detect()
        if self.addr is None:
            raise RuntimeError('GT911 not detected at 0x5D/0x14')

    def _rd(self, addr, reg, n):
        w = smbus2.i2c_msg.write(addr, [(reg >> 8) & 0xFF, reg & 0xFF])
        r = smbus2.i2c_msg.read(addr, n)
        self.bus.i2c_rdwr(w, r)
        return list(r)

    def _wr(self, reg, val):
        self.bus.i2c_rdwr(smbus2.i2c_msg.write(self.addr, [(reg >> 8) & 0xFF, reg & 0xFF, val]))

    def _detect(self):
        for a in ADDR_CANDIDATES:
            try:
                self._rd(a, REG_ID, 4)
                return a
            except OSError:
                pass
        return None

    def _reset_addr_5d(self):
        from gpiozero import DigitalOutputDevice
        rst = DigitalOutputDevice(1, initial_value=True)
        intp = DigitalOutputDevice(4, initial_value=False)
        rst.off(); time.sleep(0.02)
        intp.off(); time.sleep(0.005)
        rst.on(); time.sleep(0.02)
        intp.close()
        time.sleep(0.06)
        self._rst = rst  # keep RST high

    @staticmethod
    def to_screen(rx, ry):
        sx = 468.6 - 0.967 * ry
        sy = -6.3 + 0.964 * rx
        return (max(0, min(479, int(round(sx)))), max(0, min(319, int(round(sy)))))

    def read(self):
        """Latest touch point as (screen_x, screen_y), or None if not touched."""
        try:
            st = self._rd(self.addr, REG_STATUS, 1)[0]
        except OSError:
            return None
        pt = None
        if st & 0x80:
            if st & 0x0F:
                try:
                    p = self._rd(self.addr, REG_P1, 4)
                    rx = p[0] | (p[1] << 8)
                    ry = p[2] | (p[3] << 8)
                    pt = self.to_screen(rx, ry)
                except OSError:
                    pass
            self._wr(REG_STATUS, 0)
        return pt
