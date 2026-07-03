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
    @ObservationIgnored private var lastBrightnessSend = Date.distantPast
    @ObservationIgnored private var brightnessWork: DispatchWorkItem?
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

    /// Updates the UI immediately and throttles the BLE writes so a fast drag
    /// doesn't flood the link — while still guaranteeing the final value lands.
    func setBrightness(_ value: Int) {
        let clamped = max(0, min(100, value))
        brightness = clamped
        brightnessWork?.cancel()
        if Date().timeIntervalSince(lastBrightnessSend) > 0.07 {
            lastBrightnessSend = Date()
            send(.bright(clamped), type: .withoutResponse)
        } else {
            let work = DispatchWorkItem { [weak self] in
                self?.lastBrightnessSend = Date()
                self?.send(.bright(clamped), type: .withoutResponse)
            }
            brightnessWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.07, execute: work)
        }
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
            // INFO <file> <leds> <mode> <bright%> <speed%>
            let parts = reply.split(separator: " ")
            if parts.count >= 2 { currentPattern = String(parts[1]) }
            if parts.count >= 3, let n = Int(parts[2]) { ledCount = n }
            if parts.count >= 5, let b = Int(parts[4]) { brightness = b }
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
