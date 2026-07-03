//
//  BLEController.swift
//  LED Animator
//
//  CoreBluetooth central that discovers LED Animator devices (by service UUID),
//  connects, and exchanges the text control protocol. Observable so SwiftUI
//  views update automatically.
//

import CoreBluetooth
import Foundation
import Observation

struct DiscoveredDevice: Identifiable, Equatable {
    let id: UUID       // peripheral.identifier
    var name: String
    var rssi: Int
}

/// A solid color as the firmware carries it: 0–255 per channel.
struct RGB: Equatable {
    var r = 0
    var g = 0
    var b = 0
}

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)
}

@Observable
final class BLEController: NSObject {
    // MARK: Observed UI state
    var bluetoothOn = false
    var isScanning = false
    var devices: [DiscoveredDevice] = []
    var connectionState: ConnectionState = .disconnected
    var connectedName = ""
    var patterns: [String] = []
    var isLoadingPatterns = false
    var listFailed = false
    var listTotal = 0
    var listReceived = 0
    var currentPattern: String?
    var brightness = 100   // 0–100, seeded from INFO
    var speed = 100        // 10–400 percent, seeded from INFO
    var mode = "play"      // "play", "solid", or "off" — seeded/echoed by the device
    var solid = RGB(r: 255, g: 255, b: 255)   // last solid color the device reported (INFO)
    var firmwareVersion: String?
    var platform: String?
    var ledCount: Int?
    var freeBytes: Int?
    var wifiMac: String?
    var bluetoothMac: String?
    var hostname: String?
    var moreInfoLoaded = false   // true once the MOREINFO batch (ENDINFO) has arrived
    var lastError: String?
    // Wi-Fi provisioning
    var wifiState = "off"          // off / connecting / connected / failed
    var wifiDetail = ""            // IP when connected, short reason when failed
    var wifiNetworks: [WiFiNetwork] = []
    var isScanningWifi = false

    // MARK: CoreBluetooth internals (not observed)
    @ObservationIgnored private var central: CBCentralManager!
    @ObservationIgnored private var peripherals: [UUID: CBPeripheral] = [:]
    @ObservationIgnored private var connected: CBPeripheral?
    @ObservationIgnored private var rxChar: CBCharacteristic?
    @ObservationIgnored private var wantScan = false
    /// Per-channel rate limiter state (keyed by channel id), so fast drags on the
    /// sliders / color spectrum don't flood the BLE link. See `throttle`.
    @ObservationIgnored private var throttleLast: [String: Date] = [:]
    @ObservationIgnored private var throttleWork: [String: DispatchWorkItem] = [:]
    @ObservationIgnored private var incomingPatterns: [String] = []      // buffered FILE… until ENDLIST
    @ObservationIgnored private var listTimeoutWork: DispatchWorkItem?   // stall watchdog for LIST streaming
    @ObservationIgnored private var incomingNetworks: [WiFiNetwork] = []  // buffered WIFINET… until WIFISCANEND
    @ObservationIgnored private var wifiScanTimeoutWork: DispatchWorkItem?
    @ObservationIgnored private var moreInfoTimeoutWork: DispatchWorkItem?   // fallback if ENDINFO is dropped

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: Scanning

    func startScan() {
        wantScan = true
        devices.removeAll()
        if central.state == .poweredOn { beginScan() }
    }

    func stopScan() {
        wantScan = false
        isScanning = false
        central.stopScan()
    }

    private func beginScan() {
        guard central.state == .poweredOn else { return }
        isScanning = true
        central.scanForPeripherals(
            withServices: [LEDGATT.service],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    // MARK: Connection

    func connect(_ device: DiscoveredDevice) {
        guard let peripheral = peripherals[device.id] else { return }
        stopScan()
        connectionState = .connecting
        connectedName = device.name
        patterns = []
        incomingPatterns = []
        isLoadingPatterns = false
        listFailed = false
        listTotal = 0
        listReceived = 0
        listTimeoutWork?.cancel()
        currentPattern = nil
        firmwareVersion = nil
        platform = nil
        ledCount = nil
        freeBytes = nil
        wifiMac = nil
        bluetoothMac = nil
        hostname = nil
        moreInfoLoaded = false
        moreInfoTimeoutWork?.cancel()
        lastError = nil
        wifiState = "off"
        wifiDetail = ""
        wifiNetworks = []
        incomingNetworks = []
        isScanningWifi = false
        wifiScanTimeoutWork?.cancel()
        connected = peripheral
        peripheral.delegate = self
        central.connect(peripheral)
    }

    func disconnect() {
        if let peripheral = connected {
            central.cancelPeripheralConnection(peripheral)
        }
        connected = nil
        rxChar = nil
        listTimeoutWork?.cancel()
        isLoadingPatterns = false
        connectionState = .disconnected
    }

    func clearFailure() {
        if case .failed = connectionState { connectionState = .disconnected }
    }

    // MARK: Commands

    func send(_ command: LEDCommand, type: CBCharacteristicWriteType = .withResponse) {
        guard let peripheral = connected, let rx = rxChar,
              let data = command.text.data(using: .utf8) else { return }
        peripheral.writeValue(data, for: rx, type: type)
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

    func select(_ name: String) { send(.select(name)) }

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

    /// Minimum spacing between BLE writes on a dragged control (~11/sec). Big
    /// enough that the Pico keeps up (no backlog "light show"), small enough to
    /// feel live.
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

    /// Updates the UI immediately and rate-limits the BLE writes so a fast drag
    /// doesn't flood the link — while still guaranteeing the final value lands.
    func setBrightness(_ value: Int) {
        let clamped = max(0, min(100, value))
        brightness = clamped
        throttle("bright") { [weak self] in self?.send(.bright(clamped), type: .withoutResponse) }
    }

    /// Like `setBrightness`: updates the UI at once and rate-limits the writes.
    func setSpeed(_ value: Int) {
        let clamped = max(10, min(400, value))
        speed = clamped
        throttle("speed") { [weak self] in self?.send(.speed(clamped), type: .withoutResponse) }
    }

    /// Hold a solid color (switches the device out of pattern playback). The send
    /// is rate-limited so dragging the color spectrum doesn't back up the link.
    func setSolid(r: Int, g: Int, b: Int) {
        mode = "solid"
        let cr = max(0, min(255, r)), cg = max(0, min(255, g)), cb = max(0, min(255, b))
        throttle("solid") { [weak self] in self?.send(.solid(cr, cg, cb), type: .withoutResponse) }
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

    func forgetWifi() { send(.wifiForget) }

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

    private func handleReply(_ reply: String) {
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
        } else if reply.hasPrefix("INFO ") {
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
        } else if reply.hasPrefix("ERR") {
            lastError = reply
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEController: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetoothOn = central.state == .poweredOn
        if central.state == .poweredOn {
            if wantScan { beginScan() }
        } else {
            isScanning = false
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        peripherals[peripheral.identifier] = peripheral
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let device = DiscoveredDevice(
            id: peripheral.identifier,
            name: advName ?? peripheral.name ?? "LED device",
            rssi: RSSI.intValue
        )
        if let i = devices.firstIndex(where: { $0.id == device.id }) {
            devices[i] = device
        } else {
            devices.append(device)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([LEDGATT.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        connectionState = .failed(error?.localizedDescription ?? "Couldn't connect to the device.")
        connected = nil
        rxChar = nil
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        connected = nil
        rxChar = nil
        if connectionState == .connected || connectionState == .connecting {
            connectionState = .disconnected
        }
    }
}

// MARK: - CBPeripheralDelegate

extension BLEController: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == LEDGATT.service }) else {
            connectionState = .failed("This isn't an LED Animator device.")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([LEDGATT.rx, LEDGATT.tx], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case LEDGATT.rx: rxChar = characteristic
            case LEDGATT.tx: peripheral.setNotifyValue(true, for: characteristic)
            default: break
            }
        }
        guard rxChar != nil else {
            connectionState = .failed("The device is missing its control characteristic.")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        connectionState = .connected
        // Keep the connect exchange lean: just the live control state + the
        // pattern list. Everything else is fetched lazily when its tab opens
        // (MOREINFO for the Info tab, WIFISTATUS for the Wi-Fi tab).
        send(.info)   // confirms it's ours + reports the active pattern + controls
        refreshPatterns()   // stream the pattern list (FILE…/ENDLIST)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == LEDGATT.tx, let data = characteristic.value,
              let text = String(data: data, encoding: .utf8) else { return }
        handleReply(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
