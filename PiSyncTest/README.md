# LED Animator — Raspberry Pi Sync Test Rig

A Raspberry Pi bench rig with a touchscreen, used to develop and observe the BLE
**leader/follower sync** for the multi-device LED work (a debuggable, screen-equipped
stand-in for the Pico W devices). This first cut runs the **leader**: it broadcasts a
BLE sync beacon and shows the live state on the LCD with touch controls.

## Hardware

- **Raspberry Pi 4** (headless, no HDMI).
- **Waveshare 3.5inch RPi LCD (F)** — `ST7796S` display over **SPI**, `GT911` capacitive
  touch over **I2C** (addr `0x5D`), 320×480 native (used as 480×320 landscape).
- Wiring (Waveshare pin mapping, BCM numbering): display `RST=GPIO27 DC=GPIO22 BL=GPIO18`,
  touch on I2C-1 (`SDA=GPIO2 SCL=GPIO3`). SPI on `spidev0.0`.
- Built/verified on **Raspberry Pi OS (Debian 13 "trixie")**, Python 3.13.

## Setup (get back to this point)

### 1. Enable SPI and I2C (persistent, one time)

```bash
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
sudo reboot          # only needed the first time you enable these
```

Confirm afterwards: `ls /dev/spidev0.0 /dev/i2c-1` should both exist. Your user must be
in the `spi`, `i2c`, and `gpio` groups (default on Raspberry Pi OS) — check with `groups`.

> Note: this rig drives the panel by **pushing pixels over SPI in Python** (no framebuffer).
> Do **not** add Waveshare's `mipi-dbi-spi`/`goodix` device-tree overlay to `config.txt` —
> that path is for a Linux framebuffer and would conflict.

### 2. Install the Python libraries (APT, system packages)

```bash
sudo apt update
sudo apt install -y python3-spidev python3-smbus2 python3-pil python3-numpy \
                    python3-gpiozero python3-lgpio
```

- `spidev` — SPI to the ST7796S. `smbus2` — I2C to the GT911.
- `pil` (Pillow ≥ 10.1) — draws the UI. `numpy` — fast RGB888→RGB565 packing.
- `gpiozero` + `lgpio` — GPIO (RST/DC/backlight); gpiozero uses the lgpio backend on
  trixie. (No `RPi.GPIO` — the touch driver polls I2C directly, avoiding it.)

Fonts are optional: the UI falls back to Pillow's bundled scalable font. For crisper/bold
text, `sudo apt install -y fonts-dejavu-core`.

### 3. Display & touch specifics (already handled in the code)

- **Display** (`display.py` + vendor `st7796.py`): landscape 480×320, **MADCTL `0xF8`**
  (upright, correct RGB order — verified on hardware). Blit via `SPI.writebytes2`.
- **Touch** (`touch.py`): GT911 polled over I2C (status reg `0x814E`, point at `0x8150`).
  The panel's touch axes are swapped + long axis inverted vs. the display; the mapping is
  `screenX = 468.6 − 0.967·raw_y`, `screenY = −6.3 + 0.964·raw_x` (5-point calibrated).

### 4. Bluetooth beacon prep (each run — done by `run-leader.sh`)

The beacon uses a **raw HCI USER channel** for full control of the advertising payload.
That needs exclusive access to the controller, so before running:

```bash
sudo systemctl stop bluetooth          # release the adapter from bluetoothd
# clear the rfkill soft-block (this image has no `rfkill` CLI, so use sysfs):
for r in /sys/class/rfkill/rfkill*; do \
  [ "$(cat "$r"/type)" = bluetooth ] && echo 0 | sudo tee "$r"/soft >/dev/null; done
sudo hciconfig hci0 down               # USER channel requires the device down
```

The leader itself must run as **root** (`sudo`) to bind the HCI USER channel. This state is
runtime-only; nothing here persists across a reboot.

## Running

```bash
./run-leader.sh          # does the Bluetooth prep above, then `sudo python3 leader.py`
```

- The LCD shows role **LEADER**, a live **frame counter** (0–299 loop @ 30 fps), program #,
  brightness %, play state, and the beacon **seq** (ticks a few Hz by design).
- Touch buttons: **PAUSE/PLAY**, **PROG −/+**, **BRT −/+**.
- The beacon advertises non-connectable, company `0xFFFF`, 16-byte payload:
  `"LEDA"(4) | frame(u32 LE) | ts_ms(u32 LE) | program | brightness | flags | seq`.
  Verify in **nRF Connect**: an "N/A" device whose manufacturer data starts `4C 45 44 41`.

### Restore normal Bluetooth

```bash
sudo systemctl start bluetooth
```

## Files

| File | What |
|------|------|
| `leader.py` | The leader app (beacon + touch UI). |
| `beacon.py` | BLE sync beacon over raw HCI (USER channel). Reusable. |
| `display.py` | ST7796S landscape framebuffer wrapper. |
| `touch.py` | GT911 touch over I2C, mapped to screen coords. |
| `gfx.py` | Shared font/centering helpers. |
| `st7796.py` | **Vendor** ST7796S SPI driver (from Waveshare's `3inch5_RPI_LCD_F_RPI` demo). |
| `snap.py` | Render the leader screen to `/tmp/leader_snap.png` with no hardware (UI dev over SSH). |
| `run-leader.sh` | Bluetooth prep + launch. |

`st7796.py` is Waveshare demo code (source:
`files.waveshare.com/wiki/3.5inch_RPi_LCD_F/3inch5_RPI_LCD_F_RPI.zip`), kept here for
convenience. Everything else is ours.

## Next

Follower (scan + phase-lock) and the leader/follower protocol. See the multi-device sync
design in `docs/multi-device-sync.md`.
