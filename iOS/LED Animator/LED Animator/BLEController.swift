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
    var lastError: String?

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
        lastError = nil
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
    func rename(_ name: String) {
        let trimmed = String(name.prefix(26)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send(.setName(trimmed))
    }

    // MARK: Reply parsing

    private func handleReply(_ reply: String) {
        if reply.hasPrefix("LISTLEN ") {
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
            // INFO <leds> <mode> <bright%> <speed%> <r> <g> <b> <file...>
            // The filename is last and may contain spaces, so cap the split at 8
            // and treat the 9th piece as the whole (possibly spaced) name.
            let t = reply.split(separator: " ", maxSplits: 8, omittingEmptySubsequences: false)
            if t.count >= 2, let n = Int(t[1]) { ledCount = n }
            if t.count >= 3 { mode = String(t[2]) }
            if t.count >= 4, let b = Int(t[3]) { brightness = b }
            if t.count >= 5, let sp = Int(t[4]) { speed = sp }
            if t.count >= 8, let r = Int(t[5]), let g = Int(t[6]), let b = Int(t[7]) {
                solid = RGB(r: r, g: g, b: b)
            }
            if t.count >= 9 {
                let name = String(t[8])
                currentPattern = name.isEmpty ? nil : name
            }
        } else if reply.hasPrefix("VERSION ") {
            firmwareVersion = String(reply.dropFirst("VERSION ".count))
        } else if reply.hasPrefix("PLATFORM ") {
            platform = String(reply.dropFirst("PLATFORM ".count))
        } else if reply.hasPrefix("FREE ") {
            freeBytes = Int(reply.dropFirst("FREE ".count))
        } else if reply.hasPrefix("BRIGHT ") {
            // Unsolicited echo the device sends when it persists brightness
            // (after the slider settles) — snap the UI to the actual value.
            if let b = Int(reply.dropFirst("BRIGHT ".count)) { brightness = b }
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
        send(.info)   // confirms it's ours + reports the active pattern
        send(.version)
        send(.platform)
        send(.free)
        refreshPatterns()   // stream the pattern list (FILE…/ENDLIST)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == LEDGATT.tx, let data = characteristic.value,
              let text = String(data: data, encoding: .utf8) else { return }
        handleReply(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
