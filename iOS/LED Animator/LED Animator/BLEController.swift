//
//  BLEController.swift
//  LED Animator
//
//  CoreBluetooth central: discovers LED Animator devices (by service UUID),
//  connects, and acts as the BLE DeviceTransport for the connected device.
//  The control protocol (state, commands, reply parsing) lives in DeviceSession,
//  which this drives — so the same session runs over Wi-Fi/TCP later.
//

import CoreBluetooth
import Foundation
import Observation

/// A device seen during a scan — one row in the discovery list, refreshed as
/// new adverts arrive.
struct DiscoveredDevice: Identifiable, Equatable {
    let id: UUID       // peripheral.identifier
    var name: String
    var rssi: Int
    var deviceID: String?   // 3-byte hex from the advert (= Wi-Fi hostname suffix), for BLE<->Wi-Fi matching

    /// Parse our manufacturer data (0xFFFF company + 3-byte id) into hex.
    /// Returns nil when the advert lacks our company prefix or is too short.
    static func parseDeviceID(_ mfg: Data?) -> String? {
        guard let mfg, mfg.count >= 5 else { return nil }
        let bytes = [UInt8](mfg)
        guard bytes[0] == 0xFF, bytes[1] == 0xFF else { return nil }
        return bytes[2..<5].map { String(format: "%02X", $0) }.joined()
    }
}

/// A solid color as the firmware carries it: 0–255 per channel.
struct RGB: Equatable {
    var r = 0
    var g = 0
    var b = 0
}

/// Where a transport's connection stands, shared by BLE and TCP so the UI can
/// treat both identically.
// nonisolated so `==` can be used from nonisolated contexts (e.g. the TCP
// receive handler), independent of the project's default main-actor isolation.
nonisolated enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    /// Connect/discovery failed; the payload is a user-facing message.
    case failed(String)
}

/// CoreBluetooth central + BLE transport for LED Animator devices. Owns the
/// scan/connect lifecycle and, once a peripheral is wired up, hands a
/// `DeviceSession` the writes/notifications it needs (see `DeviceTransport`).
@Observable
final class BLEController: NSObject {
    // MARK: Observed UI state
    /// Whether the Bluetooth radio is powered on and usable.
    var bluetoothOn = false
    var isScanning = false
    /// Devices discovered so far this scan, keyed for the list by `id`.
    var devices: [DiscoveredDevice] = []
    var connectionState: ConnectionState = .disconnected
    var connectingName = ""              // name of the device being connected (for the spinner)
    var session: DeviceSession?          // the live control session, once connected

    // MARK: CoreBluetooth internals (not observed)
    @ObservationIgnored private var central: CBCentralManager!
    /// Every peripheral we've seen advertise, kept so `connect` can look one up
    /// by id after the scan list is handed to the UI.
    @ObservationIgnored private var peripherals: [UUID: CBPeripheral] = [:]
    @ObservationIgnored private var connected: CBPeripheral?
    @ObservationIgnored private var rxChar: CBCharacteristic?
    /// A scan was requested but the radio wasn't ready — start once powered on.
    @ObservationIgnored private var wantScan = false

    /// Create the central manager on the main queue so `@Observable` state can
    /// be mutated directly from its delegate callbacks.
    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: Scanning

    /// Begin a fresh scan (clears prior results). Defers until the radio is
    /// powered on if it isn't yet.
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

    /// Actually start scanning, filtered to our service UUID. No-op unless the
    /// radio is on.
    private func beginScan() {
        guard central.state == .poweredOn else { return }
        isScanning = true
        central.scanForPeripherals(
            withServices: [LEDGATT.service],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    // MARK: Connection

    /// Connect to a discovered device: stops scanning, then walks
    /// service/characteristic discovery before a session is created.
    func connect(_ device: DiscoveredDevice) {
        guard let peripheral = peripherals[device.id] else { return }
        stopScan()
        connectionState = .connecting
        connectingName = device.name
        session = nil
        connected = peripheral
        peripheral.delegate = self
        central.connect(peripheral)
    }

    /// Drop the active connection and reset all connection state.
    func disconnect() {
        if let peripheral = connected {
            central.cancelPeripheralConnection(peripheral)
        }
        connected = nil
        rxChar = nil
        session = nil
        connectionState = .disconnected
    }

    /// Dismiss a `.failed` state (e.g. after the user acknowledges the error).
    func clearFailure() {
        if case .failed = connectionState { connectionState = .disconnected }
    }
}

// MARK: - DeviceTransport

extension BLEController: DeviceTransport {
    /// Write one command to the RX characteristic. `expectResponse` selects the
    /// BLE write type (with vs. without response).
    func send(_ line: String, expectResponse: Bool) {
        guard let peripheral = connected, let rx = rxChar,
              let data = line.data(using: .utf8) else { return }
        peripheral.writeValue(data, for: rx, type: expectResponse ? .withResponse : .withoutResponse)
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEController: CBCentralManagerDelegate {
    /// Track radio power; start a pending scan when it comes on, stop scanning
    /// when it goes off.
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetoothOn = central.state == .poweredOn
        if central.state == .poweredOn {
            if wantScan { beginScan() }
        } else {
            isScanning = false
        }
    }

    /// An advert matched our service: remember the peripheral and upsert its
    /// row (prefer the advertised local name; fall back to a generic label).
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        peripherals[peripheral.identifier] = peripheral
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
        let device = DiscoveredDevice(
            id: peripheral.identifier,
            name: advName ?? peripheral.name ?? "LED device",
            rssi: RSSI.intValue,
            deviceID: DiscoveredDevice.parseDeviceID(mfg)
        )
        if let i = devices.firstIndex(where: { $0.id == device.id }) {
            devices[i] = device
        } else {
            devices.append(device)
        }
    }

    /// Connected at the GATT level — now discover our service.
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([LEDGATT.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        connectionState = .failed(error?.localizedDescription ?? "Couldn't connect to the device.")
        connected = nil
        rxChar = nil
        session = nil
    }

    /// Peripheral dropped: clear state and, if we thought we were up, fall back
    /// to disconnected (leave any `.failed` message intact).
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        connected = nil
        rxChar = nil
        session = nil
        if connectionState == .connected || connectionState == .connecting {
            connectionState = .disconnected
        }
    }
}

// MARK: - CBPeripheralDelegate

extension BLEController: CBPeripheralDelegate {
    /// Our service found → discover its RX/TX characteristics; otherwise this
    /// isn't one of our devices, so bail with a friendly error.
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == LEDGATT.service }) else {
            connectionState = .failed("This isn't an LED Animator device.")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([LEDGATT.rx, LEDGATT.tx], for: service)
    }

    /// Wire up RX (for writes) and enable TX notifications, then — if RX is
    /// present — spin up the `DeviceSession` and mark the link connected.
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
        let session = DeviceSession(name: connectingName)
        session.transport = self
        self.session = session
        connectionState = .connected
        session.start()
    }

    /// A TX notification arrived: decode and hand the trimmed reply line to the
    /// session's parser.
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == LEDGATT.tx, let data = characteristic.value,
              let text = String(data: data, encoding: .utf8) else { return }
        session?.handleReply(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
