# App update plan — sync/multi-device support

The iOS/macOS app (`iOS/LED Animator/`) predates the multi-device work; this is the
change list to bring it up to the current firmware/protocol. **Written as a plan, not
code, because it can't be built here** (the dev box has Command Line Tools, not full
Xcode) — do it in Xcode so each step compiles. The firmware already exposes everything
below (see [`protocol.md`](protocol.md)); this is purely app-side.

Ordered by value + risk. **Phase 1 is mechanical** (mirror existing patterns); Phase 2
is new UI worth designing as you go.

**Status (2026-07-07):** Phase 1 + the jukebox/teardown controls are **written** (commits
`17c3290`, `12e33ac`) but **unverified — build in Xcode to confirm** (this box has no
Xcode; cross-file SourceKit "cannot find type" warnings there are false positives). The
device-list group view and warned-connect are still **TODO** — both need the discovery
layer to parse the beacon advert first (below).

## Phase 1 — read, show, and send (low-risk) — ✅ WRITTEN

### 1. `LEDProtocol.swift` — two new commands
Add to `enum LEDCommand`:
```swift
case program(Int)   // group jukebox: play program n (leader switches the whole group)
case teardown       // leader-only: gracefully end the group
```
…and in `var text`:
```swift
case .program(let n): return "PROGRAM \(n)"
case .teardown: return "TEARDOWN"
```
(No command needed for `ROLE`/`GROUP`/`DEVICE` — they arrive via `MOREINFO`.)

### 2. `DeviceSession.swift` — model + MOREINFO parsing
Add properties next to `dataPin` (all optional, nil until `MOREINFO`):
```swift
var role: String?        // standalone / leader / leader-only / follower / auto
var syncGroup: Int?      // GROUP
var deviceSlice: Int?    // DEVICE
var program: Int?        // PROGRAM
var startup: String?     // "wait" / "go"
var lossPolicy: String?  // "indicate" / "silent" / "blackout"
```
In the `MOREINFO` parse chain (the `reply.hasPrefix(...)` block), mirror the existing
lines:
```swift
} else if reply.hasPrefix("ROLE ")    { role = String(reply.dropFirst("ROLE ".count))
} else if reply.hasPrefix("GROUP ")   { syncGroup = Int(reply.dropFirst("GROUP ".count))
} else if reply.hasPrefix("DEVICE ")  { deviceSlice = Int(reply.dropFirst("DEVICE ".count))
} else if reply.hasPrefix("PROGRAM ") { program = Int(reply.dropFirst("PROGRAM ".count))
} else if reply.hasPrefix("STARTUP ") { startup = String(reply.dropFirst("STARTUP ".count))
} else if reply.hasPrefix("LOSS ")    { lossPolicy = String(reply.dropFirst("LOSS ".count))
```
Also handle the ack `OK PROGRAM <n> [file]` (like `OK PIN`): update `program`.

### 3. `DeviceInfoView.swift` — a "Sync" section
A read-only section showing Role, Group, Device, Program, Startup, On-loss (skip nils).
Mirror the existing info rows. This is the "show it on the app" ask.

## Phase 2 — interactive (design as you build)

### 4. Jukebox + teardown (`ControlView.swift`) — ✅ WRITTEN
- A **Program** control (stepper/menu) that sends `.program(n)` — the group-wide
  pattern switch. Show it prominently for a leader/standalone; for a follower it's
  read-only (the leader drives it).
- A **Teardown** action (destructive style, confirm first) — only for `role == leader`
  / `leader-only`; expect `ERR not-leader` otherwise.

### Prerequisite for 5 & 6 — parse the beacon advert in discovery (`BLEController.swift`)
Both remaining items need the app to identify a **leader + its group before connecting**,
which means parsing the **sync beacon advert** (manufacturer data `FFFF` + `"LD"` + type
`0x02`, then `group` at the first payload byte — see [`sync-beacon.md`](sync-beacon.md))
in the BLE scan callback, and carrying `isLeader` / `group` on `DiscoveredDevice` /
`UnifiedDevice`. No firmware change needed (a leader already radiates type `0x02`).

### 5. Group representation (`DeviceListView.swift`) — TODO
Once discovery carries role/group: cluster followers under their leader by `group` — show
the group as one unit with a sync-status line, rather than N separate rows. A first cut
can just **badge** each row with role/group and sort grouped, before a full nested UI.

### 6. Warned BLE-connect to a leader — TODO
When the user taps to connect **over BLE** to a device discovery flagged as a **leader**,
warn first: "This will pause the group for the duration of the connection." Wi-Fi connects
need no warning. (Re-confirm the "beacon pauses while connected" premise with nRF first —
it may be an artifact.)

## Notes
- Everything Phase 1 needs is already in `MOREINFO`; no firmware change required.
- `iOS/README.md` build instructions are unchanged.
- Related: [`protocol.md`](protocol.md), [`multi-device-sync.md`](multi-device-sync.md),
  [`sync-beacon.md`](sync-beacon.md).
