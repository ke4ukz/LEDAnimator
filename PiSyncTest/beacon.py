#!/usr/bin/python3
"""BLE sync beacon over raw HCI (USER channel). Non-connectable advertising with
16-byte manufacturer-data payload (company 0xFFFF). Needs root + hci0 DOWN and
bluetoothd stopped (exclusive USER channel). update() rewrites the payload live."""
import ctypes
import os
import socket
import struct
import time

AF_BLUETOOTH = 31
BTPROTO_HCI = 1
HCI_CHANNEL_USER = 1
HCI_COMMAND_PKT = 0x01
HCI_EVENT_PKT = 0x04
EVT_CMD_COMPLETE = 0x0E
EVT_CMD_STATUS = 0x0F


def _op(ogf, ocf):
    return (ogf << 10) | ocf


OP_RESET = _op(0x03, 0x0003)
OP_ADV_PARAMS = _op(0x08, 0x0006)
OP_ADV_DATA = _op(0x08, 0x0008)
OP_ADV_ENABLE = _op(0x08, 0x000A)

GROUP_DEFAULT = b'LEDA'


def pack_payload(group=GROUP_DEFAULT, frame=0, ts=0, program=7, bright=255, flags=1, seq=0):
    """group(4 raw) + frame(u32 LE) + ts_ms(u32 LE) + program + bright + flags + seq = 16 bytes."""
    return group[:4].ljust(4, b'\x00') + struct.pack(
        '<IIBBBB', frame & 0xFFFFFFFF, ts & 0xFFFFFFFF, program & 0xFF, bright & 0xFF, flags & 0xFF, seq & 0xFF)


def _adv_data(payload):
    mfg = bytes([1 + 2 + len(payload), 0xFF, 0xFF, 0xFF]) + payload  # len, 0xFF type, company 0xFFFF, payload
    ad = b'\x02\x01\x06' + mfg                                       # Flags AD + manufacturer AD
    return bytes([len(ad)]) + ad + b'\x00' * (31 - len(ad))


class Beacon:
    def __init__(self, dev=0, interval_ms=100):
        self.s = socket.socket(AF_BLUETOOTH, socket.SOCK_RAW, BTPROTO_HCI)
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        addr = struct.pack('<HHH', AF_BLUETOOTH, dev, HCI_CHANNEL_USER)
        if libc.bind(self.s.fileno(), addr, len(addr)) != 0:
            e = ctypes.get_errno()
            raise OSError(e, f'HCI USER-channel bind failed: {os.strerror(e)}')
        self.s.settimeout(2.0)
        iv = int(interval_ms / 0.625)
        self._cmd(OP_RESET)
        self._cmd(OP_ADV_PARAMS, struct.pack('<HHBBB6sBB', iv, iv, 0x03, 0, 0, b'\x00' * 6, 0x07, 0))
        self.update(pack_payload())
        self._cmd(OP_ADV_ENABLE, b'\x01')

    def _cmd(self, opcode, params=b''):
        self.s.send(struct.pack('<BHB', HCI_COMMAND_PKT, opcode, len(params)) + params)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                data = self.s.recv(258)
            except socket.timeout:
                return None
            if not data or data[0] != HCI_EVENT_PKT:
                continue
            if data[1] == EVT_CMD_COMPLETE and len(data) >= 7 and (data[4] | (data[5] << 8)) == opcode:
                return data[6]
            if data[1] == EVT_CMD_STATUS and len(data) >= 7 and (data[5] | (data[6] << 8)) == opcode:
                return data[3]
        return None

    def update(self, payload):
        return self._cmd(OP_ADV_DATA, _adv_data(payload))

    def stop(self):
        try:
            self._cmd(OP_ADV_ENABLE, b'\x00')
        finally:
            self.s.close()
