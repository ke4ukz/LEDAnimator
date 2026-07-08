# Device config overrides + auth PIN — plan

Two related pieces of **device-level** config, designed and ready to build. Behavior
overrides are partly built already; the auth PIN is new. Written 2026-07-07.

## 1. Behavior overrides (loss / startup) — the two-level model

The resolution of "should the `.leda` carry behavior, or should it be device config?" is
**both**, by precedence:

```
device override (if set)  >  animation header default  >  firmware default
```

- **Header default (per-animation):** each `.leda` carries loss/startup, stamped at export.
  With *no* override, the firmware applies each file's header on load — so switching
  program 7 → 3 switches behavior with it. This is the "animation carries behavior" case;
  it's the **default**.
- **Device override (per-device pin):** set at runtime from the app → persisted → wins over
  the header for **all** animations until cleared. This is "pin this device, ignore what the
  animation wants." Applying to all is the point, not a bug.

### Status — ✅ **BUILT (2026-07-07)**, firmware compiles / app written (needs Xcode build)
- ✅ Header default (each `.leda` carries loss/startup; applied on every file load —
  uploading/switching a pattern applies *that* pattern's behavior).
- ✅ **Per-field override** — `S.loss_override` / `S.startup_override` (independent), header
  values remembered in `S.loss_header` / `S.startup_header`; effective = override ? override :
  header. `syncflags.txt` stores only the pinned fields as tokens (`L<0-2>` / `S<0-1>`), and is
  removed when nothing is pinned. (Replaced the old single `syncflags_set` int file.)
- ✅ **Clear / revert** — `LOSS default` / `STARTUP default` drop that field's override and
  recompute the effective value from the current header (no reload). App surfaces this as the
  first picker option **"Automatic (use animation)"**: selecting it sends `… default` (deletes
  the config entry); a concrete value pins the override. When set to Automatic the picker shows
  a **"Following the animation · <value>"** caption so the effective behavior stays visible.
- ✅ **Override warning** — `MOREINFO` emits `OVERRIDES <none | loss | startup | loss,startup>`;
  the app parses it into `lossOverridden` / `startupOverridden` and gates the caption/revert on
  it. (Device-row list badge still optional — not built; Info-view caption covers the warning.)

*(Fancy version, still YAGNI: per-**program** overrides on one device — a keyed map instead of a
single override. Noted, not built.)*

## 2. Auth PIN — challenge-response — ✅ **BUILT (2026-07-07)**, firmware HW-validated / app written

Firmware + app done; firmware validated end-to-end on a live Pico W over TCP (SETPASS →
locked → INFO returns `NEEDPIN <nonce>` → wrong `LOGIN` = `ERR auth` → immediate retry =
`ERR auth-wait` → after cooldown correct `LOGIN` = `OK LOGIN` → state flows → `CLEARPASS` →
open again; socket-keyed session dicts confirmed working on-device). App: DeviceSession does
the CryptoKit `sha256(pin+nonce)` + parses `NEEDPIN`/`AUTH set|none`; ControlView shows an
Unlock prompt on `needsLogin`; DeviceInfoView has a **Security** section (set/change/remove
PIN). App unbuilt in Xcode as of writing.

Casual/hobby-grade deterrent (stop a neighbor poking your lights); **not** protection against
physical access (reset/USB dump wins — RP2350 secure boot is the real lock, see
[`future-directions.md`](future-directions.md)). Design as built:

- **Storage:** `auth.txt` (a device config file), set/cleared when authenticated.
- **Challenge-response, so the PIN never travels in the clear:**
  - Pre-login `INFO` (locked + unauthenticated) returns a minimal `pin_required=yes;
    nonce=<hex>` (a fresh nonce per connection).
  - Client sends `LOGIN <sha256(pin + nonce)>` (MicroPython `hashlib`).
  - Device verifies → the **connection** is authenticated (tracked per BLE conn / TCP client;
    forgotten on disconnect).
- **Gate:** while locked + unauthenticated, reject every command with `ERR auth` **except**
  `INFO` (which returns the nonce). Everything else — including Wi-Fi provisioning — is behind
  auth. (Provisioning is over BT and you hold the PIN, so gating it is fine: authenticate,
  then provision.)
- **Open until set:** no `auth.txt` → open (needed for first-ever BLE provisioning). Setting a
  PIN locks it; clearing it re-opens.
- **Manage (authenticated only):** `SETPASS <pin>` set/change, `CLEARPASS` remove — both
  settable from the app. *(Avoid the name `PIN`; it's already the GPIO-pin command.)*
- **Rate-limit:** a ~5 s delay after each failed `LOGIN` (serial, so naturally one-at-a-time;
  4-digit × 5 s ≈ 14 h). Linear is plenty — physical reset is the real bypass.
- **Caveat:** a short PIN is still offline-brute-forceable from one captured nonce+hash, so
  allow a longer passphrase if that matters. Full link encryption (BLE bonding / TLS) is the
  real fix and is overkill here.

## 3. Forgotten-PIN recovery — the power-cycle ritual (planned, ⏳ UNBUILT)

A set PIN can be forgotten, and since a locked device gates *everything* but
`PING`/`INFO`/`LOGIN` (even Wi-Fi provisioning), a lockout would otherwise be permanent.
The escape hatch is the existing **power-cycle recovery ritual** — deliberately re-folded
in to also clear the PIN. It's a *physical* act, so it works regardless of auth: **a PIN is
never a permanent lockout.**

**Mechanism (unchanged from the original design, see
[`multi-device-sync.md`](multi-device-sync.md)):** a tiny counter file is bumped **very early
in boot** (before BLE/Wi-Fi init, so it sticks even if init hangs); the pattern still plays
instantly every boot; once the device has run past a **~5 s commit window** the counter resets
to 0. The criterion is simply *"did you let it run past the commit window before pulling
power."* The action fires **at the threshold boot itself** and flashes the whole strip so you
get "keep cycling until it flashes" feedback. A 5-minimum guards against accidental
double-boots.

**Thresholds (decision 2026-07-07 — "unlock first, full reset later"):**

| Count | Action | Keeps | Strip flash |
|---|---|---|---|
| **5th** short boot | **Clear the PIN only** (remove `auth.txt`) | group + Wi-Fi | cyan (`pin-cleared`) |
| **10th** short boot | **Full reset:** de-group **and** clear Wi-Fi (`networks.txt`) **and** clear the PIN | nothing | magenta (`factory-reset`) |

Rationale: the gentlest, most-reached ritual targets exactly the forgotten-PIN lockout and
preserves everything else; the old "5 = de-group but keep Wi-Fi" step folds into the 10 full
reset (with Wi-Fi up you can already re-provision from the app, so the physical de-group only
matters when you're heading to a full wipe anyway).

**Build TODO:**
- **Counter:** bump `bootcount.txt` at the very top of `main()` (before the strip clear / BLE);
  reset it to 0 in the player loop once `time.ticks_ms()` since boot passes the commit window.
- **Threshold actions:** at 5 → `_save_auth()` with `auth_pin=None`; at 10 → also remove
  `networks.txt` + trigger the de-group override (below). Fire `_flash_strip` with the color.
- **De-group at boot** needs a mechanism because role/group live in the **header**, not a file
  (see §4). Simplest: a `standalone.txt` recovery-override that `_apply_role_header` respects
  (forces `role="standalone"`, ignores the header's role/group) until the next upload/SELECT
  clears it — the same override shape as `syncflags.txt`. (Ties into the §4 identity decision:
  if identity moves to files, de-group is just deleting those files instead.)
- **Flash colors:** add `pin-cleared` (cyan) to the `_RECOVERY` table; keep `factory-reset`
  (magenta) for the 10th. (The old white `standalone`/magenta `wifi-cleared` entries collapse
  into these two.)
- **Recovery-UF2** remains the ultimate backstop (a one-drag firmware that forces standalone +
  open).

## 4. Still open (decide separately) — identity in the header vs config files

The override model settles **behavior** (loss/startup). It does **not** settle **identity**
(role / group / device-id). The open question: should an uploaded animation be able to change
*what a device is*? Leaning toward **files-win-for-identity** (so uploading a pattern to a
follower can't silently flip it to a leader), but the cost is that the "leader-only = a
header-only `.leda`" trick needs another mechanism (e.g. a `role.txt`). Not blocking; decide
when ready.

## Related
[`protocol.md`](protocol.md) · [`multi-device-sync.md`](multi-device-sync.md) ·
[`app-update-plan.md`](app-update-plan.md) · [`future-directions.md`](future-directions.md)
