# Getting Started — from a pattern to glowing LEDs

This guide assumes **no** microcontroller experience. By the end you'll have a
pattern from the web editor running on a Raspberry Pi Pico W and controllable from
the companion app. If a term is unfamiliar, there's a plain-language glossary at
the bottom.

## What you need

- A **Raspberry Pi Pico W** (the "W" adds Bluetooth + Wi‑Fi, which the app needs
  to talk to it). A plain Pico works for playback but can't be controlled
  wirelessly.
- A **WS2812 / "NeoPixel" LED strip** (individually addressable). One data wire,
  plus power and ground.
- A **USB cable** (the same one that came with the Pico — must be a *data* cable,
  not charge-only).
- A computer with a web browser, and (for control) an iPhone/iPad or Mac.
- For a lot of LEDs: a **separate 5 V power supply**. USB alone can only drive a
  few dozen LEDs at full brightness.

## The easy path: one-drag UF2 (recommended)

This needs **nothing installed** on your computer or the Pico. The web editor
builds a single file that contains everything — the MicroPython runtime, the
player program, your pattern, and the settings — and you just drop it on the Pico.

### 1. Export the UF2

1. In the web editor, build your pattern.
2. Click **Export**.
3. **Target device:** `RP2040 (Pico / Pico W)`.
4. **Format:** `One-drag UF2 (blank Pico W)`.
5. Set the **Device name** (what shows up in the app), the **Data pin (GP)** your
   strip's data wire connects to, and a starting **Brightness**.
6. Click **Download UF2**. You get `led-animation-picow.uf2` (~4 MB).

> The size warning in the dialog is an *estimate* — you can export anyway. See
> [the status/notes](STATUS.md) for how file size scales.

### 2. Put the Pico into bootloader mode

The Pico only accepts a UF2 while in **bootloader mode**:

1. **Unplug** the Pico.
2. **Press and hold the BOOTSEL button** (the only button on the board).
3. While holding it, **plug the USB cable** into your computer.
4. Release the button.

A new **removable drive named `RPI-RP2`** appears, like a tiny USB stick. That's
the Pico waiting for firmware.

### 3. Flash it

**Drag `led-animation-picow.uf2` onto the `RPI-RP2` drive.** The drive
disappears, the Pico reboots, and your pattern starts playing (assuming the strip
is wired — see below).

That's it. There is nothing to "install" and no code to run.

> **If the strip stays dark** after flashing, some machines corrupt the drag-copy.
> Install [`picotool`](https://github.com/raspberrypi/picotool) and run:
> `picotool load led-animation-picow.uf2` — then unplug/replug.

## Wiring the strip

Three connections from the Pico to the strip:

| Strip wire | Connect to | Notes |
|---|---|---|
| **Data / DIN** | the **GP pin** you set as "Data pin" during export | Default is GP0. |
| **GND** | any **GND** pin on the Pico | **Must** share ground with the Pico. |
| **5V / VCC** | Pico **VBUS** (USB 5 V) for a few LEDs, *or* a separate 5 V supply for many | For many LEDs use an external supply and join its ground to the Pico's. |

- The strip has a direction — connect to the **input** end (arrows point *away*
  from DIN).
- Powering more than ~20–50 LEDs at full white from the Pico's USB can brown it
  out. Use an external 5 V supply and tie the grounds together.

## Connecting from the app

1. Install / open the **LED Animator companion app** (build it in Xcode from
   [`iOS/`](../iOS/) — see [`iOS/README.md`](../iOS/README.md)).
2. Power the Pico W (USB is fine).
3. The app scans for devices over **Bluetooth** automatically. Your device shows
   up under the name you set at export. Tap it to connect.
4. From the control screen you can set **brightness**, **speed**, a **solid
   color**, turn the strip **off / on**, pick a different **pattern**, rename the
   device, and set up **Wi‑Fi**.

Once Wi‑Fi is configured (in the app), the device is also reachable over your
network — the app prefers Wi‑Fi when available and falls back to Bluetooth.

## Changing the pattern later

- **Switch among patterns already on the device:** just pick one in the app.
- **Add a new pattern without reflashing everything:** export the **Pattern
  `.leda`** format and copy it onto the board (see the advanced path), then
  select it in the app. You do *not* need to re-flash MicroPython for this.
- **Replace everything:** export a new one-drag UF2 and repeat the flash steps.

## The advanced path: mpremote / Thonny

Use this if you want to manage files on a Pico that **already runs MicroPython**,
or you prefer working at the command line. The one-drag UF2 above already includes
MicroPython, so you only need this for the `.zip` / `.leda` export formats.

### Put MicroPython on the board (only if it isn't already)

The one-drag UF2 does this for you. To do it manually, flash a MicroPython UF2 the
same way as step 2–3 above (bootloader mode, drag the UF2). Use the version the
exporter targets — currently **MicroPython v1.28.0 for Pico W**. (The editor
bundles this exact build into the one-drag UF2; if flashing MicroPython yourself,
match that version.)

### Copy files with `mpremote`

[`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html) is a
small command-line tool for talking to MicroPython boards over USB.

```bash
pip install mpremote            # one-time install (needs Python)

# from the folder where you unzipped the "MicroPython files (.zip)" export:
mpremote connect auto fs cp main.py :            # the player program
mpremote connect auto fs cp yourpattern.leda :   # your pattern data
mpremote connect auto fs cp datapin.txt :        # settings files
mpremote connect auto fs cp bright.txt :
mpremote connect auto fs cp devicename.txt :
mpremote connect auto fs cp selected.txt :
mpremote connect auto reset                      # restart to run it
```

The `.zip` export contains exactly these files (plus `project.json` and a
`README.txt`). The `:` means "the board's filesystem."

### Or use Thonny

[Thonny](https://thonny.org/) is a beginner-friendly editor with a **Files** panel.
Set the interpreter to *MicroPython (Raspberry Pi Pico)*, then drag the exported
files onto the device pane. Same result, no command line.

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| No `RPI-RP2` drive appears | It's a *charge-only* cable, or you didn't hold BOOTSEL while plugging in. Try another cable/port. |
| Flashed, but the strip is dark | Wrong **data pin** (re-export with the right GP), strip wired to the *output* end, no shared ground, or not enough power. Also try the `picotool load` fallback. |
| First few LEDs light, rest don't | Power browning out — add an external 5 V supply, ground tied to the Pico. |
| App doesn't find the device | Make sure it's a Pico **W**, powered, and Bluetooth is on for the phone/Mac. A plain Pico can't be controlled wirelessly. |
| Colors look washed out / oversaturated | That's a pattern-authoring thing (source Adjustments), not the hardware. |

## Glossary

- **UF2** — a file format for flashing microcontrollers by *drag-and-drop*. Copy
  it to the board's drive and it installs itself.
- **BOOTSEL** — the button that puts the Pico into "accept a UF2" (bootloader)
  mode, exposing the `RPI-RP2` drive.
- **MicroPython** — a small Python that runs *on* the microcontroller. Our player
  program is written in it.
- **`mpremote` / Thonny** — tools for copying files to a MicroPython board and
  running code on it.
- **WS2812 / NeoPixel** — addressable RGB LEDs; each pixel gets its own color over
  a single data wire.
- **GP pin** — a general-purpose pin on the Pico (GP0, GP1, …). The strip's data
  wire connects to one of these.
- **`.leda`** — our raw pattern file (the baked raster: row = LED, column = frame).
