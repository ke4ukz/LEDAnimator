#!/usr/bin/env python3
"""End-to-end BLE control test for the Rust firmware.

Scans for the LED Animator device (by name or the service UUID), connects, and
runs a sequence of protocol commands over the Nordic-UART-style characteristics,
printing each reply. Watch the strip while it runs — SOLID/BRIGHT/OFF are visible.

Run from any machine with a working BLE central + `bleak`:
    python3 -m venv venv && venv/bin/pip install bleak
    venv/bin/python firmware-rust/tools/ble_test.py

(macOS needs Bluetooth permission granted to the terminal; on Linux the default
BlueZ adapter must be free — not held by another HCI-user program.)
"""
import asyncio
from bleak import BleakScanner, BleakClient

SVC = "4c454441-0001-4000-8000-4c4544415254"
RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # write commands here
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # replies notify here


async def main():
    print("scanning for LED Animator (8s)...")
    dev = None
    for d, adv in (await BleakScanner.discover(timeout=8.0, return_adv=True)).values():
        if (d.name and "LED Animator" in d.name) or SVC in [u.lower() for u in adv.service_uuids]:
            dev = d
            print("found:", d.name, d.address, "| service_uuids:", adv.service_uuids)
            break
    if not dev:
        print("NOT FOUND")
        return

    replies = []
    async with BleakClient(dev) as c:
        print("connected:", c.is_connected)
        await c.start_notify(TX, lambda _h, data: replies.append(bytes(data).decode("utf-8", "replace")))

        async def cmd(s, pause=0.4):
            replies.clear()
            await c.write_gatt_char(RX, s.encode(), response=False)
            await asyncio.sleep(pause)
            print(f"  {s:24} -> {replies}")

        await cmd("PING")            # OK
        await cmd("VERSION")         # VERSION rust-0.1
        await cmd("PLATFORM")        # PLATFORM Raspberry Pi Pico W with RP2040
        await cmd("INFO")            # INFO play 100 100 0 0 0 <file>
        await cmd("BRIGHT 25")       # OK BRIGHT 25  (strip dims)
        await cmd("INFO")            # INFO play 25 ...
        await cmd("SOLID 0 255 0")   # OK SOLID      (strip green)
        await cmd("INFO")            # INFO solid 25 100 0 255 0 ...
        await cmd("SPEED 200")       # OK SPEED 200
        await cmd("PLAY")            # OK PLAY       (pattern resumes, 2x speed)
        await cmd("BADCMD")          # ERR unknown
        await cmd("OFF")             # OK OFF        (strip blanks)
        await c.stop_notify(TX)
    print("done")


asyncio.run(main())
