# Building the device firmware

How the player that runs on the Pico is authored, tested, and shipped. For the
*protocol* it speaks see [`protocol.md`](protocol.md); for the on-disk pattern
format see [`file-format.md`](file-format.md).

> **Two firmwares.** The **Rust** firmware ([`firmware-rust/`](../firmware-rust))
> is the go-forward: it has full feature parity and more. The **MicroPython**
> player (the rest of this doc) is **dormant** — kept as a fallback, not actively
> developed. New work goes into the Rust firmware.

## Build matrix — one source, N targets

`firmware-rust/` is a **single source tree** that builds for multiple boards and
radio configurations, selected by Cargo **features** (Arduino-style board macros,
done the Rust way). Everything platform-specific lives in **`src/board/`** (the
`PLATFORM` string, the CYW43 clock divider, …) plus a per-target `memory-<t>.x`;
the rest of `src/` is written once against `board::*`. Adding a target = one
feature + one `board/<t>.rs` + one `memory-<t>.x` + a `build.rs` arm.

**Platform** (exactly one; `default = rp2350`): `rp2040` (Pico W, Cortex-M0+) ·
`rp2350` (Pico 2 W, Cortex-M33). The feature selects the `embassy-rp` chip, the
target triple, the boot/link script, and (via `build.rs`) `memory-<t>.x`. A
missing/ambiguous selection is a `compile_error!` in `src/board/mod.rs`.

**Radios** (default on, omit to exclude): `wifi` · `bt`. They gate *optional*
deps (cyw43 / embassy-net / trouble-host), so a build without them compiles no
radio stack at all — **nothing on the airwaves, nothing flashed** — for a fixed
pattern on a board that shouldn't broadcast.

```bash
cargo build --release          # default = Pico 2 W, Wi-Fi + BT (same as `cargo rp2350`)
cargo rp2040                   # Pico W, Wi-Fi + BT (alias in .cargo/config.toml)
# Silent fixed-pattern lamp — no radio stack compiled:
cargo build --release --no-default-features --features rp2040 --target thumbv6m-none-eabi
# BT control, no Wi-Fi broadcast:
cargo build --release --no-default-features --features rp2350,bt
```

The aliases (`cargo rp2040` / `cargo rp2350`) live in `.cargo/config.toml`; the
default `cargo build` targets the Pico 2 W. `promote-firmware` (below) is keyed by
the same platform names.

## Shipping a Rust firmware build to the website

Firmware development in `firmware-rust/` is **decoupled** from what the site
ships. The website bundles a **pinned** firmware build; updating it is a
deliberate, separate step you run only when a build is validated and you want it
live — never automatically.

```bash
cd firmware-rust && cargo build --release      # then make the .uf2 (elf2uf2-rs)
# …flash + validate on hardware…
cd ../web && npm run promote-firmware           # roll THIS build to the site (rp2040)
```

`promote-firmware` ([`web/scripts/promote-firmware.mjs`](../web/scripts/promote-firmware.mjs)):

- copies the target's UF2 → `web/src/assets/led-animator-<target>.uf2` (a stable,
  target-named slot, so the export's `?url` import never churns);
- updates that **target's** entry in `firmwareReleases.generated.json` and
  regenerates the typed
  [`web/src/export/firmwareRelease.generated.ts`](../web/src/export/firmwareRelease.generated.ts)
  the app imports — with the **version** (read from `FW_VERSION`, so the site
  advertises exactly what the device reports), the **flash/littlefs layout** +
  **UF2 family** (read from the firmware source, so it can't drift), the source
  **commit**, size, and promotion date;
- warns if the firmware tree has **uncommitted changes** (the UF2 might not match
  the recorded commit).

Review the diff, then commit the UF2 + the generated files to ship it. Bump
`FW_VERSION` in the firmware *before* promoting when you want a new version string
on the wire and on the site. (Override the source UF2 with a path:
`npm run promote-firmware rp2040 -- path/to.uf2`.)

### Multiple targets (RP2350 and beyond)

Releases are **keyed by target platform** (`rp2040`, and later `rp2350`, …), so
promoting one never touches the others (`firmwareReleases.generated.json` is
merged, not overwritten):

```bash
npm run promote-firmware rp2350      # once that firmware build exists
```

Adding a target is a `TARGETS` entry in the promote script — its firmware root,
built artifact, and **format**. Not every target is a UF2: `format` is one of
`uf2` (RP2040/RP2350, spliced with a littlefs image), `hex` (ATmega), `img` (Pi
disk image), `bin` (ESP32), … The asset lands as `led-animator-<target>.<format>`,
and the release records that `format` + `file`. The UF2-only bits (family +
littlefs base/size) live in an **optional `combinedUf2`** block that non-UF2
formats simply omit.

The RP2350 firmware itself is a separate build (its own `embassy-rp` chip feature,
`memory.x`, littlefs base/size, UF2 family, and likely secure-boot signing); the
promotion step just pins whatever artifact that build produces. The web export
selects the pinned release for the chosen target and handles it per `format`.

## MicroPython player (dormant)

## Where the firmware lives

The entire player is one MicroPython program, kept as a **JavaScript template
literal** in [`web/src/export/rp2040.ts`](../web/src/export/rp2040.ts)
(`rp2040MainPy()`). It's a template literal — not a `.py` file — so the web
editor is the single source for every export (UF2, `.zip`, and the precompiled
blob) with no separate build artifact to keep in sync.

**Template-literal gotchas** (the string is Python source inside JS backticks):

- **No backticks** anywhere in the Python (comments included) — one closes the JS
  string early and generation fails with a cryptic esbuild/parse error.
- **No `${`** — it would interpolate. The *only* intentional interpolation is
  `FW_VERSION = ${JSON.stringify(build)}` (a build-id string); everything else is
  literal.
- Escape sequences meant for Python must be **double-escaped**: write `"\\n"` in
  the `.ts` to emit a literal `\n` in the Python.
- If generation throws, the old output file is left **stale** and a following
  `py_compile` passes on it silently — so **always confirm the generator printed
  `wrote … chars`** before trusting a test.

Two derived forms exist alongside `rp2040MainPy()`:

- `rp2040ModulePy()` — the same source minus the trailing top-level `main()` call,
  so it imports cleanly as a module (this is what gets compiled to `leda.mpy`).
- `RP2040_LOADER_PY` — the tiny `main.py` that ships next to the blob:
  `import leda` / `leda.main()`.

## Dev loop (iterate on a bench Pico)

For fast iteration, flash the **source** `main.py` directly — no compile step:

```bash
cd web
npx tsx gen-firmware.ts /tmp/leda_main.py     # writes runnable main.py (with main())
python3 -m py_compile /tmp/leda_main.py        # syntax check — CONFIRM "wrote … chars" above
mpremote cp /tmp/leda_main.py :main.py
mpremote reset
```

Iterate a single run without persisting: `mpremote run /tmp/leda_main.py`.

**mpremote gotchas:**

- `mpremote fs …` / `exec` **interrupt the running `main()`** (they drop to the
  raw REPL). So they make anything time-based look "stuck" — e.g. the power-cycle
  boot counter never reaches its commit reset while you're poking the FS. To watch
  live boot behavior, read the serial port for the boot prints; to check live
  state, use the TCP control port (which `main()` services) — don't interleave
  `mpremote fs`.
- A follower hang after a flash is almost always the CYW43 radio-bring-up clash —
  power-cycle to recover.
- In shell loops, **inline the ssh command**; don't store it in a zsh var (it
  won't word-split).

Flashing source is fine for the bench, but it pays the on-device compile cost on
every boot (see below). What actually ships is precompiled.

## Shipping: precompiled `leda.mpy`

The player source is ~90 KB; MicroPython recompiles it on **every boot**, which
takes **~3 s** on an RP2040 before the program even starts (measured 2.97 s
soft-reboot → first app print). Since the source is effectively static, we
precompile it once to bytecode (`leda.mpy`) and ship that plus the loader — the
board loads bytecode instead of compiling, dropping the same measurement to
**1.22 s**, and the recovery-ritual boot counter (which bumps before BLE init)
registers even sooner.

```bash
cd web
npm run gen:mpy      # compiles rp2040ModulePy() -> leda.mpy, embeds it base64
```

`gen:mpy` runs [`web/gen-mpy.ts`](../web/gen-mpy.ts), which writes
[`web/src/export/firmwareMpy.generated.ts`](../web/src/export/firmwareMpy.generated.ts)
— a **committed** file containing the base64 blob, the arch/build it was made for,
and a version-neutral `sourceSha`. The UF2 and `.zip` exports
([`combinedUf2.ts`](../web/src/export/combinedUf2.ts) /
[`ExportDialog.tsx`](../web/src/components/ExportDialog.tsx)) write `leda.mpy` +
the loader `main.py` into the device filesystem instead of the source.

### After editing `rp2040.ts`, regenerate the blob

The blob is committed, so a stale one would silently ship old firmware. Guarding
against that: the `build` script has a **`prebuild` hook**
([`check-mpy.ts`](../web/check-mpy.ts)) that re-hashes the current source and
**fails the build** if it doesn't match the blob's `sourceSha`. So the rule is:

> **Edit `rp2040.ts` → run `npm run gen:mpy` → commit the regenerated
> `firmwareMpy.generated.ts` with your change.**

The check is hash-only (no `mpy-cross` needed), so a normal `npm run build` stays
Python-free; only regeneration needs the toolchain.

### mpy-cross setup + version matching

`gen:mpy` shells out to **`mpy-cross`**, which must emit the `.mpy` format version
the board's MicroPython expects:

```bash
pip install "mpy-cross==1.28.0rc0.post2"   # emits mpy v6.3 — matches the bundled MicroPython v1.28
```

To find the board's `.mpy` version, read `sys.implementation._mpy` on it — the low
byte is the format version (`4870 & 0xff == 6` → v6). If you bump the bundled
MicroPython UF2, bump `mpy-cross` to match and regenerate.

### Architecture + version specificity

The player uses `@micropython.viper` (the DMA buffer-fill hot path), which
compiles to **native machine code**, so `leda.mpy` is **not portable**:

- **Architecture-specific** — built with `-march=armv6m` for the RP2040 / Pico W.
  A Pico 2 W (RP2350, a different core) needs its own blob built with its arch.
- **MicroPython-version-specific** — tied to the `.mpy` format (v6.3 / v1.28
  here). The bundled runtime UF2 must match.

This is an accepted trade (a Rust firmware would be arch-specific too). To add a
second board later: build a second blob with its `-march`, and select the right
one per target at export time.

## Pinned MicroPython runtime

The one-drag UF2 bundles a specific MicroPython build,
`web/src/assets/RPI_PICO_W-v1.28.0.uf2`, and a verified filesystem layout
(`PICO_W_FIRMWARE` in [`combinedUf2.ts`](../web/src/export/combinedUf2.ts)). To
bump it: replace the asset, run `os.statvfs('/')` on a board flashed with the new
runtime and update `blockCount`, bump `mpy-cross` + rerun `npm run gen:mpy`, and
re-test a one-drag flash end to end.

## Related

[`protocol.md`](protocol.md) · [`file-format.md`](file-format.md) ·
[`future-directions.md`](future-directions.md) (the compiled-Rust-on-RP2350
direction this precompile step is a step toward) · [`STATUS.md`](STATUS.md)
