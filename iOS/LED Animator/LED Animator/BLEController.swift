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
    var connectingName = ""              // name of the device being connected (for the spinner)
    var session: DeviceSession?          // the live control session, once connected

    // MARK: CoreBluetooth internals (not observed)
    @ObservationIgnored private var central: CBCentralManager!
    @ObservationIgnored private var peripherals: [UUID: CBPeripheral] = [:]
    @ObservationIgnored private var connected: CBPeripheral?
    @ObservationIgnored private var rxChar: CBCharacteristic?
    @ObservationIgnored private var wantScan = false

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
        connectingName = device.name
        session = nil
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
        session = nil
        connectionState = .disconnected
    }

    func clearFailure() {
        if case .failed = connectionState { connectionState = .disconnected }
    }
}

// MARK: - DeviceTransport

extension BLEController: DeviceTransport {
    func send(_ line: String, expectResponse: Bool) {
        guard let peripheral = connected, let rx = rxChar,
              let data = line.data(using: .utf8) else { return }
        peripheral.writeValue(data, for: rx, type: expectResponse ? .withResponse : .withoutResponse)
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
        session = nil
    }

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
        let session = DeviceSession(name: connectingName)
        session.transport = self
        self.session = session
        connectionState = .connected
        session.start()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == LEDGATT.tx, let data = characteristic.value,
              let text = String(data: data, encoding: .utf8) else { return }
        session?.handleReply(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
