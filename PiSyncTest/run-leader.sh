#!/bin/bash
# Prepare the Bluetooth controller for exclusive HCI control, then run the leader.
# The BLE beacon uses a raw HCI USER channel, which needs: root, bluetoothd
# stopped, the rfkill soft-block cleared, and hci0 down.
set -e
sudo systemctl stop bluetooth 2>/dev/null || true
for r in /sys/class/rfkill/rfkill*; do
  [ "$(cat "$r/type" 2>/dev/null)" = bluetooth ] && echo 0 | sudo tee "$r/soft" >/dev/null
done
sudo hciconfig hci0 down 2>/dev/null || true
cd "$(dirname "$0")"
exec sudo python3 leader.py
