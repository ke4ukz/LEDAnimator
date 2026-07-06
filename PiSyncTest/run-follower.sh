#!/bin/bash
# Prepare the controller for exclusive HCI scanning, then run the follower.
# (Same BLE prep as the leader: bluetoothd stopped, rfkill cleared, hci0 down.)
set -e
sudo systemctl stop bluetooth 2>/dev/null || true
for r in /sys/class/rfkill/rfkill*; do
  [ "$(cat "$r/type" 2>/dev/null)" = bluetooth ] && echo 0 | sudo tee "$r/soft" >/dev/null
done
sudo hciconfig hci0 down 2>/dev/null || true
cd "$(dirname "$0")"
exec sudo python3 follower.py "$@"
