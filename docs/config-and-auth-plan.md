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
