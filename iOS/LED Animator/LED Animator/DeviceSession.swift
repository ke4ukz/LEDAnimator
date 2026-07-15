//
//  DeviceSession.swift
//  LED Animator
//
//  The transport-agnostic control session: holds the observed device state,
//  sends commands, and parses replies. Driven by any DeviceTransport (BLE now,
//  TCP later) — it never touches CoreBluetooth or sockets directly. SwiftUI
//  control views observe this object.
//

import Foundation
import CryptoKit
import Observation

/// The transport-agnostic control session for one connected device.
///
/// Holds the observed device state, sends commands, and parses replies. It is
/// driven by any `DeviceTransport` (BLE now, TCP later) and never touches
/// CoreBluetooth or sockets directly, so control views bind to this one object
/// regardless of link. `@Observable` so SwiftUI re-renders on any state change.
@Observable
final class DeviceSession {
    // MARK: Observed state

    /// The device's advertised/display name; updated on a successful rename.
    var connectedName: String
    /// Pattern filenames on the device, sorted, shown once a LIST finishes.
    var patterns: [String] = []
    /// True while a LIST stream is in flight (drives the loading indicator).
    var isLoadingPatterns = false
    /// True if the LIST stream stalled and the watchdog gave up.
    var listFailed = false
    /// Expected pattern count from LISTLEN, for a determinate progress bar.
    var listTotal = 0
    /// FILE lines received so far in the current LIST stream.
    var listReceived = 0
    /// The pattern currently playing, or nil when none/off.
    var currentPattern: String?
    /// Live control state, mirrored to the sliders.
    var brightness = 100   // 0–100, seeded from INFO
    var speed = 100        // 10–400 percent, seeded from INFO
    var mode = "play"      // "play", "solid", or "off" — seeded/echoed by the device
    var solid = RGB(r: 255, g: 255, b: 255)   // last solid color the device reported (INFO)
    // MOREINFO details for the Info tab (nil until that batch streams in).
    var firmwareVersion: String?
    var platform: String?
    var ledCount: Int?
    var freeBytes: Int?
    var wifiMac: String?
    var bluetoothMac: String?
    var hostname: String?
    var powerSource: String?     // "usb", "batt", or "unknown" (nil until first POWER)
    var vsysMillivolts: Int?     // VSYS in mV; nil when the board can't measure it
    var dataPin: Int?            // GP pin the strip data line is on (from MOREINFO / PIN)
    // Multi-device sync state (from MOREINFO; nil until that batch streams in).
    var role: String?            // standalone / leader / leader-only / follower / auto
    var syncGroup: Int?          // installation / sync group id
    var deviceSlice: Int?        // render-slice id (which device's slice this is)
    var program: Int?            // current program number (the group's jukebox selection)
    var startupPolicy: String?   // follower boot: "wait" / "go" (EFFECTIVE value)
    var lossPolicy: String?      // follower on sync loss: "indicate" / "silent" / "blackout" (EFFECTIVE)
    // Which policy fields are pinned as device overrides (win over the animation's
    // header). Parsed from MOREINFO's OVERRIDES line; used to warn/offer "revert".
    var lossOverridden = false
    var startupOverridden = false
    var moreInfoLoaded = false   // true once the MOREINFO batch (ENDINFO) has arrived
    // Auth (see docs/config-and-auth-plan.md). A locked device answers our connect
    // INFO with a NEEDPIN challenge; we prompt, hash the PIN with the nonce, LOGIN.
    var needsLogin = false       // device is locked and this connection isn't authed yet
    var authenticated = false    // this connection has logged in
    var pinIsSet = false         // a PIN is set on the device (from MOREINFO AUTH)
    var authError: String?       // "Incorrect PIN" / "Too many attempts…" for the prompt
    @ObservationIgnored private var loginNonce: String?   // the challenge to hash against
    @ObservationIgnored private var loginAttempted = false   // a LOGIN is in flight (distinguishes wrong-PIN from just-locked)
    /// Last "ERR…" reply, surfaced for debugging/UI feedback.
    var lastError: String?
    // Wi-Fi provisioning
    var wifiState = "off"          // off / connecting / connected / failed
    var wifiDetail = ""            // IP when connected, short reason when failed
    /// Networks from the most recent WIFISCAN, strongest first.
    var wifiNetworks: [WiFiNetwork] = []
    /// True while a WIFISCAN is streaming (drives the scan spinner).
    var isScanningWifi = false

    // MARK: Transport + internals (not observed)

    /// The active link (BLE/TCP). Weak: the transport owns the session's lifetime.
    @ObservationIgnored weak var transport: DeviceTransport?
    /// Per-channel rate limiter state (keyed by channel id), so fast drags on the
    /// sliders / color spectrum don't flood the link. See `throttle`.
    @ObservationIgnored private var throttleLast: [String: Date] = [:]
    @ObservationIgnored private var throttleWork: [String: DispatchWorkItem] = [:]
    @ObservationIgnored private var incomingPatterns: [String] = []      // buffered FILE… until ENDLIST
    @ObservationIgnored private var listTimeoutWork: DispatchWorkItem?   // stall watchdog for LIST streaming
    @ObservationIgnored private var incomingNetworks: [WiFiNetwork] = []  // buffered WIFINET… until WIFISCANEND
    @ObservationIgnored private var wifiScanTimeoutWork: DispatchWorkItem?
    @ObservationIgnored private var moreInfoTimeoutWork: DispatchWorkItem?   // fallback if ENDINFO is dropped

    /// - Parameter name: the device name known at connect time (from the advert).
    init(name: String) {
        connectedName = name
    }

    /// Called once the transport is connected and ready. Keep the connect
    /// exchange lean: just the live control state + the pattern list. Everything
    /// else is fetched lazily when its tab opens (MOREINFO / WIFISTATUS).
    func start() {
        send(.info)   // confirms it's ours + reports the active pattern + controls
        refreshPatterns()   // stream the pattern list (FILE…/ENDLIST)
    }

    // MARK: Commands

    /// Serialize a command to its text form and hand it to the transport.
    /// `expectResponse: false` for fire-and-forget writes (dragged controls).
    private func send(_ command: LEDCommand, expectResponse: Bool = true) {
        transport?.send(command.text, expectResponse: expectResponse)
    }

    /// Requests the pattern list. Replies stream as LISTLEN/FILE…/ENDLIST — the
    /// list stays hidden (previous contents kept underneath) until ENDLIST, then
    /// it's sorted and shown. Arms the stall watchdog.
    func refreshPatterns() {
        incomingPatterns = []
        listReceived = 0
        listTotal = 0
        listFailed = false
        isLoadingPatterns = true
        send(.list)
        armListTimeout()
    }

    /// Switch the device to the named pattern (confirmed by OK SELECT).
    func select(_ name: String) { send(.select(name)) }
    /// Group jukebox: play program n. On a leader this switches the whole group.
    func selectProgram(_ n: Int) { send(.program(max(0, min(255, n)))) }
    /// Leader-only: gracefully end the group (its followers stop).
    func teardown() { send(.teardown) }
    /// Pin the follower on-sync-loss policy ("indicate"/"silent"/"blackout") as a
    /// device override — live + persisted, wins over every animation's header.
    func setLossPolicy(_ name: String) { lossPolicy = name; lossOverridden = true; send(.setLoss(name)) }
    /// Drop the loss override so the animation's own header takes back over. The
    /// resulting header value arrives in the OK LOSS ack.
    func revertLoss() { lossOverridden = false; send(.setLoss("default")) }
    /// Pin the follower boot behavior ("wait"/"go") as a device override.
    func setStartup(_ name: String) { startupPolicy = name; startupOverridden = true; send(.setStartup(name)) }
    /// Drop the startup override so the animation's header takes back over.
    func revertStartup() { startupOverridden = false; send(.setStartup("default")) }

    // MARK: Auth

    /// Answer the NEEDPIN challenge: hash the entered PIN with the device's nonce
    /// (so the PIN never travels in the clear) and LOGIN. No-op without a nonce —
    /// `requestChallenge()` fetches one first.
    func login(pin: String) {
        guard let nonce = loginNonce else { requestChallenge(); return }
        authError = nil
        loginAttempted = true
        send(.login(Self.sha256Hex(pin + nonce)))
    }
    /// Set or change the device PIN (only works while authed or open).
    func setPin(_ pin: String) { send(.setPass(pin)) }
    /// Remove the PIN / unlock the device (only works while authed).
    func clearPin() { send(.clearPass) }
    /// Ask the device for a fresh login challenge (it replies NEEDPIN <nonce>).
    func requestChallenge() { send(.info) }

    /// Drop into the locked state (device requires auth, we're not authed) and get
    /// a fresh challenge so the unlock screen can (re)try. Idempotent.
    private func enterLocked() {
        needsLogin = true
        authenticated = false
        pinIsSet = true
        requestChallenge()
    }

    /// Lowercase hex SHA-256 of a string's UTF-8 bytes — matches the firmware's
    /// `sha256(pin + nonce)` (see rp2040.ts `_expected_login`).
    private static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Delete a pattern file. The device refuses to delete the active one
    /// ("ERR in-use"); the app hides that option, but the guard is defense in depth.
    func delete(_ name: String) { send(.delete(name)) }

    /// Fetch the Info-tab details (version, LEDs, free space, MACs, hostname,
    /// platform). They stream back as discrete labeled replies ending in ENDINFO.
    /// Until then fields read "Loading"; after, a missing field reads "N/A".
    func requestMoreInfo() {
        moreInfoLoaded = false
        send(.moreInfo)
        moreInfoTimeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.moreInfoLoaded = true }
        moreInfoTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }

    /// Poll live power status; the device replies "POWER usb|batt|unknown <mv>".
    /// Called by the Info panel on open and periodically while it stays visible.
    func requestPower() { send(.power) }

    /// Re-point the strip's data GP pin. The device re-inits its output on the
    /// new pin and persists it; we update the UI optimistically (echoed by OK PIN).
    func setDataPin(_ n: Int) {
        let clamped = max(0, min(29, n))
        dataPin = clamped
        send(.setPin(clamped))
    }

    /// If the LIST stream goes quiet (a dropped FILE/ENDLIST, or the device
    /// stops), stop showing "loading" after a few seconds and keep whatever
    /// files already arrived. Reset on every FILE so a long list won't trip it.
    private func armListTimeout() {
        listTimeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.isLoadingPatterns = false
            self?.listFailed = true
            self?.listTimeoutWork = nil
        }
        listTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
    }

    /// Minimum spacing between writes on a dragged control (~11/sec). Big enough
    /// that the device keeps up (no backlog "light show"), small enough to feel live.
    private static let dragInterval: TimeInterval = 0.09

    /// Leading + trailing rate limiter. Runs `action` at once if this channel
    /// hasn't fired within `dragInterval`; otherwise coalesces to a single
    /// trailing run at the next slot (replacing any pending one), so a burst of
    /// updates collapses to the latest value and the final value always lands.
    private func throttle(_ id: String, interval: TimeInterval = dragInterval, _ action: @escaping () -> Void) {
        throttleWork[id]?.cancel()
        throttleWork[id] = nil
        let now = Date()
        let last = throttleLast[id] ?? .distantPast
        let elapsed = now.timeIntervalSince(last)
        if elapsed >= interval {
            throttleLast[id] = now
            action()
        } else {
            let work = DispatchWorkItem { [weak self] in
                self?.throttleLast[id] = Date()
                self?.throttleWork[id] = nil
                action()
            }
            throttleWork[id] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + (interval - elapsed), execute: work)
        }
    }

    /// Updates the UI immediately and rate-limits the writes so a fast drag
    /// doesn't flood the link — while still guaranteeing the final value lands.
    func setBrightness(_ value: Int) {
        let clamped = max(0, min(100, value))
        brightness = clamped
        throttle("bright") { [weak self] in self?.send(.bright(clamped), expectResponse: false) }
    }

    /// Like `setBrightness`: updates the UI at once and rate-limits the writes.
    func setSpeed(_ value: Int) {
        let clamped = max(10, min(400, value))
        speed = clamped
        throttle("speed") { [weak self] in self?.send(.speed(clamped), expectResponse: false) }
    }

    /// Hold a solid color (switches the device out of pattern playback). The send
    /// is rate-limited so dragging the color spectrum doesn't back up the link.
    func setSolid(r: Int, g: Int, b: Int) {
        mode = "solid"
        let cr = max(0, min(255, r)), cg = max(0, min(255, g)), cb = max(0, min(255, b))
        throttle("solid") { [weak self] in self?.send(.solid(cr, cg, cb), expectResponse: false) }
    }

    /// Blank the strip (solid black).
    func turnOff() {
        mode = "off"
        send(.off)
    }

    /// Resume playing the selected pattern.
    func play() {
        mode = "play"
        send(.play)
    }

    /// Rename the device; the board persists it and re-advertises under the name.
    /// Restricted to printable ASCII (the name rides the protocol + BLE advert).
    func rename(_ name: String) {
        let ascii = String(name.unicodeScalars.filter { (32..<127).contains($0.value) })
        let trimmed = ascii.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send(.setName(String(trimmed.prefix(26))))
    }

    // MARK: Wi-Fi provisioning

    /// Ask the device for its current Wi-Fi state (reply arrives as "WIFI …").
    func requestWifiStatus() { send(.wifiStatus) }

    /// Scan for nearby networks; results stream as WIFINET… and land in
    /// `wifiNetworks` on WIFISCANEND. Arms a stall watchdog (the device scan
    /// blocks ~2s before it streams).
    func scanWifi() {
        incomingNetworks = []
        isScanningWifi = true
        send(.wifiScan)
        armWifiScanTimeout()
    }

    /// Send credentials and join. SSID/password go as separate commands (each
    /// takes the rest of the line) so spaces in either are preserved.
    func connectWifi(ssid: String, password: String) {
        let name = ssid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        wifiState = "connecting"
        wifiDetail = ""
        send(.wifiSSID(name))
        send(.wifiPass(password))
        send(.wifiConnect)
    }

    /// Clear saved credentials and disconnect (confirmed by OK WIFIFORGET).
    func forgetWifi() { send(.wifiForget) }

    /// Fallback for the WIFISCAN stream: after ~6s, commit whatever networks
    /// arrived and drop the spinner even if WIFISCANEND never came. Reset on
    /// each WIFINET so a slow scan won't trip it early.
    private func armWifiScanTimeout() {
        wifiScanTimeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.wifiNetworks = self.incomingNetworks
            self.isScanningWifi = false
            self.wifiScanTimeoutWork = nil
        }
        wifiScanTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.0, execute: work)
    }

    // MARK: Reply parsing

    /// Called by the transport for each complete reply line.
    func handleReply(_ reply: String) {
        if reply.hasPrefix("LISTLEN ") {
            // Start of a list — reset the accumulator so a pushed/repeat list
            // replaces rather than appends (routing means we only get our own,
            // but this keeps us correct if the device ever pushes a fresh list).
            incomingPatterns = []
            listReceived = 0
            listTotal = Int(reply.dropFirst("LISTLEN ".count)) ?? 0
            armListTimeout()
        } else if reply.hasPrefix("FILE ") {
            incomingPatterns.append(String(reply.dropFirst("FILE ".count)))
            listReceived = incomingPatterns.count
            armListTimeout()   // progress — reset the stall watchdog
        } else if reply == "ENDLIST" {
            patterns = incomingPatterns.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            isLoadingPatterns = false
            listTimeoutWork?.cancel()
        } else if reply.hasPrefix("NEEDPIN ") {
            // The device is locked: it answered INFO with a fresh login challenge.
            // Stash the nonce and let the UI prompt for the PIN.
            loginNonce = String(reply.dropFirst("NEEDPIN ".count))
            needsLogin = true
            authenticated = false
            pinIsSet = true
        } else if reply.hasPrefix("INFO ") {
            // A real state line means we're through the gate (open or authed).
            needsLogin = false
            authenticated = true
            // Lean control state: INFO <mode> <bright%> <speed%> <r> <g> <b> <file...>
            // The filename is last and may contain spaces, so cap the split at 7
            // and treat the 8th piece as the whole (possibly spaced) name.
            let t = reply.split(separator: " ", maxSplits: 7, omittingEmptySubsequences: false)
            if t.count >= 2 { mode = String(t[1]) }
            if t.count >= 3, let b = Int(t[2]) { brightness = b }
            if t.count >= 4, let sp = Int(t[3]) { speed = sp }
            if t.count >= 7, let r = Int(t[4]), let g = Int(t[5]), let b = Int(t[6]) {
                solid = RGB(r: r, g: g, b: b)
            }
            if t.count >= 8 {
                let name = String(t[7])
                currentPattern = name.isEmpty ? nil : name
            }
        } else if reply.hasPrefix("VERSION ") {          // MOREINFO fields ↓
            firmwareVersion = String(reply.dropFirst("VERSION ".count))
        } else if reply.hasPrefix("LEDS ") {
            ledCount = Int(reply.dropFirst("LEDS ".count))
        } else if reply.hasPrefix("PLATFORM ") {
            platform = String(reply.dropFirst("PLATFORM ".count))
        } else if reply.hasPrefix("FREE ") {
            freeBytes = Int(reply.dropFirst("FREE ".count))
        } else if reply.hasPrefix("WIFIMAC ") {
            wifiMac = String(reply.dropFirst("WIFIMAC ".count))
        } else if reply.hasPrefix("BTMAC ") {
            bluetoothMac = String(reply.dropFirst("BTMAC ".count))
        } else if reply.hasPrefix("HOSTNAME ") {
            hostname = String(reply.dropFirst("HOSTNAME ".count))
        } else if reply.hasPrefix("NAME ") {
            // A bare "NAME <x>" — the device pushed a rename (another client changed
            // it, or a no-arg NAME query) — so the title updates live. The device list
            // picks the new name up separately via discovery.
            connectedName = String(reply.dropFirst("NAME ".count))
        } else if reply.hasPrefix("PIN ") {
            dataPin = Int(reply.dropFirst("PIN ".count))
        } else if reply.hasPrefix("ROLE ") {
            role = String(reply.dropFirst("ROLE ".count))
        } else if reply.hasPrefix("GROUP ") {
            syncGroup = Int(reply.dropFirst("GROUP ".count))
        } else if reply.hasPrefix("DEVICE ") {
            deviceSlice = Int(reply.dropFirst("DEVICE ".count))
        } else if reply.hasPrefix("PROGRAM ") {
            program = Int(reply.dropFirst("PROGRAM ".count))
        } else if reply.hasPrefix("STARTUP ") {
            startupPolicy = String(reply.dropFirst("STARTUP ".count))
        } else if reply.hasPrefix("LOSS ") {
            lossPolicy = String(reply.dropFirst("LOSS ".count))
        } else if reply.hasPrefix("OVERRIDES ") {
            // "OVERRIDES none" or a comma list of pinned policy fields (loss, startup).
            let list = String(reply.dropFirst("OVERRIDES ".count))
            let fields = list == "none" ? [] : list.split(separator: ",").map { String($0) }
            lossOverridden = fields.contains("loss")
            startupOverridden = fields.contains("startup")
        } else if reply.hasPrefix("AUTH ") {
            // MOREINFO status: "AUTH set" (a PIN is set) / "AUTH none" (open).
            pinIsSet = reply.dropFirst("AUTH ".count) == "set"
        } else if reply.hasPrefix("POWER ") {
            // "POWER <usb|batt|unknown> <mv>" (mv 0 = voltage unavailable).
            let parts = reply.split(separator: " ")
            if parts.count >= 2 { powerSource = String(parts[1]) }
            if parts.count >= 3, let mv = Int(parts[2]), mv > 0 {
                vsysMillivolts = mv
            } else {
                vsysMillivolts = nil
            }
        } else if reply == "ENDINFO" {
            moreInfoLoaded = true
            moreInfoTimeoutWork?.cancel()
        } else if reply.hasPrefix("BRIGHT ") {
            // Unsolicited echo the device sends when it persists brightness
            // (after the slider settles) — snap the UI to the actual value.
            if let b = Int(reply.dropFirst("BRIGHT ".count)) { brightness = b }
        } else if reply.hasPrefix("SPEED ") {
            // Unsolicited echo when speed settles, so other clients stay in sync.
            if let sp = Int(reply.dropFirst("SPEED ".count)) { speed = sp }
        } else if reply.hasPrefix("OK SELECT ") {
            currentPattern = String(reply.dropFirst("OK SELECT ".count))
            mode = "play"
        } else if reply.hasPrefix("OK SPEED ") {
            if let sp = Int(reply.dropFirst("OK SPEED ".count)) { speed = sp }
        } else if reply == "OK PLAY" {
            mode = "play"
        } else if reply == "OK OFF" {
            mode = "off"
        } else if reply == "OK SOLID" {
            mode = "solid"
        } else if reply.hasPrefix("OK NAME ") {
            connectedName = String(reply.dropFirst("OK NAME ".count))
        } else if reply.hasPrefix("OK DELETE ") {
            let name = String(reply.dropFirst("OK DELETE ".count))
            patterns.removeAll { $0 == name }
        } else if reply.hasPrefix("OK PIN ") {
            if let n = Int(reply.dropFirst("OK PIN ".count)) { dataPin = n }
        } else if reply.hasPrefix("OK PROGRAM ") {
            // "OK PROGRAM <n> [file]" — the first token after is the program number.
            let rest = reply.dropFirst("OK PROGRAM ".count)
            if let n = Int(rest.prefix(while: { $0 != " " })) { program = n }
            mode = "play"
        } else if reply.hasPrefix("OK LOSS ") {
            lossPolicy = String(reply.dropFirst("OK LOSS ".count))
        } else if reply.hasPrefix("OK STARTUP ") {
            startupPolicy = String(reply.dropFirst("OK STARTUP ".count))
        } else if reply.hasPrefix("WIFISCANLEN ") {
            incomingNetworks = []
            armWifiScanTimeout()
        } else if reply.hasPrefix("WIFINET ") {
            // "WIFINET <rssi> <ssid...>" — ssid is last so spaces survive.
            let rest = reply.dropFirst("WIFINET ".count)
            if let sp = rest.firstIndex(of: " ") {
                let ssid = String(rest[rest.index(after: sp)...])
                if let rssi = Int(rest[..<sp]), !ssid.isEmpty {
                    incomingNetworks.append(WiFiNetwork(ssid: ssid, rssi: rssi))
                }
            }
            armWifiScanTimeout()
        } else if reply == "WIFISCANEND" {
            wifiNetworks = incomingNetworks
            isScanningWifi = false
            wifiScanTimeoutWork?.cancel()
        } else if reply.hasPrefix("WIFI ") {
            // "WIFI <state> <detail>" — detail is the IP or a short reason.
            let rest = reply.dropFirst("WIFI ".count)
            if let sp = rest.firstIndex(of: " ") {
                wifiState = String(rest[..<sp])
                wifiDetail = String(rest[rest.index(after: sp)...])
            } else {
                wifiState = String(rest)
                wifiDetail = ""
            }
        } else if reply == "OK WIFIFORGET" {
            wifiState = "off"
            wifiDetail = ""
        } else if reply == "OK LOGIN" {
            // Authenticated: clear the prompt and reload the state the gate hid.
            authenticated = true
            needsLogin = false
            authError = nil
            loginNonce = nil
            loginAttempted = false
            start()
        } else if reply == "OK SETPASS" {
            // We just set the PIN — this connection stays authed.
            pinIsSet = true
            authenticated = true
            needsLogin = false
        } else if reply == "OK CLEARPASS" {
            pinIsSet = false
        } else if reply == "ERR auth-wait" {
            // Rate-limited after a wrong PIN; get a fresh challenge for the retry.
            authError = "Too many attempts — wait a few seconds."
            loginAttempted = false
            enterLocked()
        } else if reply == "ERR auth" {
            // Locked and not authed: a wrong PIN, or a command refused because
            // another controller just set a PIN. Either way, show the locked
            // screen and fetch a fresh challenge so the user can (re)try.
            if loginAttempted { authError = "Incorrect PIN." }
            loginAttempted = false
            enterLocked()
        } else if reply == "ERR exists" {
            // Tried to set a PIN when one is already set — remove it first.
            pinIsSet = true
            lastError = "A PIN is already set. Remove it before setting a new one."
        } else if reply.hasPrefix("ERR") {
            lastError = reply
        }
    }
}
