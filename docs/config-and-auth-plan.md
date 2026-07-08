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

### Status
- ✅ Header default, set-override + persist (`syncflags.txt`), and app pickers — **built +
  hardware-validated** (firmware) / written (app).
- ⏳ Two things remain (below).

### TODO a — per-field override (refine storage)
Today a single `syncflags_set` flag pins **both** loss and startup together, so setting one
from the app silently pins the other to its current value. Make them **independent**:
- Replace `syncflags_set` with `S.loss_override` + `S.startup_override` (bools).
- `syncflags.txt` stores only the overridden fields (e.g. tokens `L2` / `S1`; absence = not
  overridden).
- Keep the header values available (store `S.loss_header`/`S.startup_header` in
  `_apply_role_header`) so the *effective* value = override ? override : header, and clearing
  recomputes from the header with no reload.

### TODO b — clear / revert
A way to drop an override so the header takes back over (per field):
- Firmware: `LOSS default` / `STARTUP default` → clear that field's override + rewrite
  `syncflags.txt` + recompute the effective value from the current header.
- App: the loss/startup pickers get a 4th option **"Use the animation's setting"** that sends
  the clear.

### TODO c — override warning (the thing you flagged)
So a user knows a device isn't following its animation:
- Firmware: `MOREINFO` reports which fields are pinned — an `OVERRIDES <none | loss | startup |
  loss,startup>` line (cleanest to parse) alongside the existing `LOSS`/`STARTUP` values.
- App: in the Info view, show a caption on a pinned picker ("Overriding the animation") and
  offer the revert option; optionally a small **"overridden"** badge on the device row in the
  list.

*(Fancy version, almost certainly YAGNI: per-**program** overrides on one device — a keyed
map instead of a single override. Note it, don't build it.)*

## 2. Auth PIN — challenge-response

Casual/hobby-grade deterrent (stop a neighbor poking your lights); **not** protection against
physical access (reset/USB dump wins — RP2350 secure boot is the real lock, see
[`future-directions.md`](future-directions.md)). Design agreed:

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

## 3. Still open (decide separately) — identity in the header vs config files

The override model settles **behavior** (loss/startup). It does **not** settle **identity**
(role / group / device-id). The open question: should an uploaded animation be able to change
*what a device is*? Leaning toward **files-win-for-identity** (so uploading a pattern to a
follower can't silently flip it to a leader), but the cost is that the "leader-only = a
header-only `.leda`" trick needs another mechanism (e.g. a `role.txt`). Not blocking; decide
when ready.

## Related
[`protocol.md`](protocol.md) · [`multi-device-sync.md`](multi-device-sync.md) ·
[`app-update-plan.md`](app-update-plan.md) · [`future-directions.md`](future-directions.md)
