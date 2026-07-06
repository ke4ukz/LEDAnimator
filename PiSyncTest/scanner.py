#!/usr/bin/python3
"""Scan for LED Animator adverts (16-bit UUID 0x1EDA + magic 'LD') over raw HCI
and decode them — device-info (type 0x01) and leader sync beacons (type 0x02).
This is the follower's receive path. Run with sudo; bluetoothd stopped, hci0
down/unblocked (see run-scanner.sh). See docs/sync-beacon.md."""
import ctypes
import os
import socket
import struct
import sys
import time

AF_BLUETOOTH = 31
BTPROTO_HCI = 1
HCI_CHANNEL_USER = 1
HCI_COMMAND_PKT = 0x01
HCI_EVENT_PKT = 0x04
EVT_CMD_COMPLETE = 0x0E
EVT_LE_META = 0x3E


def op(ogf, ocf):
    return (ogf << 10) | ocf


OP_RESET = op(0x03, 0x0003)
OP_SCAN_PARAMS = op(0x08, 0x000B)
OP_SCAN_ENABLE = op(0x08, 0x000C)


class HCI:
    def __init__(self, dev=0):
        self.s = socket.socket(AF_BLUETOOTH, socket.SOCK_RAW, BTPROTO_HCI)
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        addr = struct.pack('<HHH', AF_BLUETOOTH, dev, HCI_CHANNEL_USER)
        if libc.bind(self.s.fileno(), addr, len(addr)) != 0:
            e = ctypes.get_errno()
            raise OSError(e, f'HCI USER-channel bind failed: {os.strerror(e)}')

    def cmd(self, opcode, params=b''):
        self.s.settimeout(2)
        self.s.send(struct.pack('<BHB', HCI_COMMAND_PKT, opcode, len(params)) + params)
        while True:
            try:
                d = self.s.recv(258)
            except socket.timeout:
                return None
            if len(d) >= 7 and d[0] == HCI_EVENT_PKT and d[1] == EVT_CMD_COMPLETE and (d[4] | (d[5] << 8)) == opcode:
                return d[6]


def parse_ads(data):
    out = {}
    i = 0
    while i < len(data):
        ln = data[i]
        if ln == 0:
            break
        t = data[i + 1]
        out.setdefault(t, []).append(data[i + 2:i + 1 + ln])
        i += 1 + ln
    return out


def main():
    hci = HCI(0)
    hci.cmd(OP_RESET)
    # passive scan, interval/window 0x0030 (~30ms), public addr, no filter
    hci.cmd(OP_SCAN_PARAMS, struct.pack('<BHHBB', 0x00, 0x0030, 0x0030, 0x00, 0x00))
    hci.cmd(OP_SCAN_ENABLE, struct.pack('<BB', 0x01, 0x00))  # enable, keep duplicates
    print('scanning for 0x1EDA / "LD" adverts...')
    sys.stdout.flush()
    hci.s.settimeout(5)
    while True:
        try:
            d = hci.s.recv(258)
        except socket.timeout:
            continue
        if len(d) < 5 or d[0] != HCI_EVENT_PKT or d[1] != EVT_LE_META or d[3] != 0x02:
            continue  # not an LE Advertising Report
        idx = 5  # skip pkt(1) evt(1) plen(1) subevent(1) num_reports(1)
        et = d[idx]; at = d[idx + 1]; addr = d[idx + 2:idx + 8]; dlen = d[idx + 8]  # noqa: F841
        adv = d[idx + 9:idx + 9 + dlen]
        rssi = d[idx + 9 + dlen] - 256 if d[idx + 9 + dlen] > 127 else d[idx + 9 + dlen]
        ads = parse_ads(adv)
        if not any(v == b'\xda\x1e' for v in ads.get(0x03, [])):
            continue  # not our 16-bit UUID
        a = ':'.join('%02X' % b for b in addr[::-1])
        for m in ads.get(0xFF, []):
            if len(m) < 5 or m[0:2] != b'\xff\xff' or m[2:4] != b'LD':
                continue  # magic check
            typ = m[4]
            if typ == 0x02 and len(m) >= 5 + 13:
                g, fr, ts, pr, br, fl, sq = struct.unpack('<BIIBBBB', m[5:5 + 13])
                print('BEACON %s rssi=%d grp=%d frame=%d ts=%d prog=%d bright=%d flags=%d seq=%d'
                      % (a, rssi, g, fr, ts, pr, br, fl, sq))
            elif typ == 0x01:
                print('DEVICE %s rssi=%d id=%s' % (a, rssi, m[5:8].hex()))
            sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
