# LED Animator — BLE advertising & sync-beacon wire format

The single contract shared by the firmware (`web/src/export/rp2040.ts`), the Pi test
rig (`PiSyncTest/beacon.py`), and the iOS/macOS apps. All multi-byte integers are
**little-endian**.

## Advertising

Every LED Animator device advertises with a fixed **16-bit identity UUID `0x1EDA`**
("LEDA") in the Service-UUIDs list, so scanners (esp. iOS) can filter efficiently and
in the background. This 16-bit code is a **coarse filter only** — it is *not* unique
and *not* trusted on its own. The real identification is the payload's magic + type,
which every consumer **must** validate (see below). The 128-bit GATT service UUID
`4C454441-0001-4000-8000-4C4544415254` remains the actual service used *after
connecting*; it is no longer needed in the advert.

Advertising data (≤31 bytes):

| AD | type | bytes | value |
|----|------|-------|-------|
| Flags | `0x01` | 3 | `06` (LE General Disc. + BR/EDR not supported) |
| 16-bit Service UUID (complete) | `0x03` | 4 | `DA 1E` (`0x1EDA`, little-endian) |
| Manufacturer Specific Data | `0xFF` | rest | see payload |

Manufacturer data value:

```
FF FF        company id 0xFFFF  (the "no company" sentinel)
4C 44        MAGIC "LD"          (validate this — rejects collisions on 0x1EDA)
<type>       payload type (1 byte)
<payload…>   type-specific
```

**Validation (firmware + app):** accept only if company == `0xFFFF` **and** magic ==
`"LD"` **and** the type is known **and** the length matches. Otherwise ignore the device
entirely. A third-party device that happens to advertise `0x1EDA` fails the magic check
and is never treated as ours.

## Payload types

### Type `0x01` — device info (standalone / any role)
```
<type=0x01> <device_id: 3 bytes>
```
`device_id` = last 3 bytes of the Wi-Fi MAC (same as the hostname suffix), so the app can
correlate this device across BLE and Wi-Fi. (Replaces today's bare `0xFFFF`+id advert.)

### Type `0x02` — sync beacon (leader)
```
<type=0x02>
<group:    u8>    leader/installation id — followers bind to this (0 = unbound)
<frame:    u32>   current frame index in the loop
<ts_ms:    u32>   leader clock (ms) at broadcast, for phase-lock
<program:  u8>    program number the group is playing
<bright:   u8>    0–255
<flags:    u8>    bit0 = playing, bit1 = teardown, bit2 = pairing (rest reserved)
<seq:      u8>    increments every advert; detect stale/duplicate
```
13-byte payload. Full advert ≈ 27/31 bytes, so there's still headroom.

- The leader broadcasts this continuously (a few Hz), **including while phone-connected**
  (validate advertise-while-connected on the CYW43 — the rig is for this).
- Followers **scan** for adverts matching the filter + magic + type `0x02` + their bound
  `group`, and phase-lock a free-running frame counter to `frame`/`ts_ms`.
- Because the beacon carries program/bright/flags, changing them on the leader propagates
  group-wide with no upload ("jukebox").

## Notes

- `0x1EDA` reads like "LEDA" and is not a standard GATT service; the magic guard makes any
  collision harmless, so no SIG assignment is needed.
- The Pi rig's earlier draft used a 4-byte `"LEDA"` group + 4-byte frame; it will be
  updated to this format so Pi ↔ Pico interop is byte-exact.
