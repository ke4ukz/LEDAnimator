# App update plan — sync/multi-device support

The iOS/macOS app (`iOS/LED Animator/`) predates the multi-device work; this is the
change list to bring it up to the current firmware/protocol. **Written as a plan, not
code, because it can't be built here** (the dev box has Command Line Tools, not full
Xcode) — do it in Xcode so each step compiles. The firmware already exposes everything
below (see [`protocol.md`](protocol.md)); this is purely app-side.

Ordered by value + risk. **Phase 1 is mechanical** (mirror existing patterns); Phase 2
is new UI worth designing as you go.

## Phase 1 — read, show, and send (low-risk, pattern-following)

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

### 4. Jukebox + teardown (`ControlView.swift`)
- A **Program** control (stepper/menu) that sends `.program(n)` — the group-wide
  pattern switch. Show it prominently for a leader/standalone; for a follower it's
  read-only (the leader drives it).
- A **Teardown** action (destructive style, confirm first) — only for `role == leader`
  / `leader-only`; expect `ERR not-leader` otherwise.

### 5. Group representation (`DeviceListView.swift`)
Cluster followers under their leader by `syncGroup` — show the group as one unit with a
sync-status line, rather than N separate rows. This is the biggest piece; a first cut
can just **badge** each device with its role/group and sort grouped, before a full
nested UI.

### 6. Warned BLE-connect to a leader
When the user taps to connect **over BLE** to a device the app knows is a **group
leader**, warn first: "This will pause the group for the duration of the connection."
The app can tell a leader from the **advert type** during scanning — a leader radiates
the **sync beacon** (manufacturer data type `0x02`, see [`sync-beacon.md`](sync-beacon.md)),
vs a non-leader's device-info advert (type `0x01`). So detection is possible pre-connect
without any new firmware. Wi-Fi connects need no warning. (Re-confirm the "beacon pauses
while connected" premise with nRF first — it may be an artifact.)

## Notes
- Everything Phase 1 needs is already in `MOREINFO`; no firmware change required.
- `iOS/README.md` build instructions are unchanged.
- Related: [`protocol.md`](protocol.md), [`multi-device-sync.md`](multi-device-sync.md),
  [`sync-beacon.md`](sync-beacon.md).
