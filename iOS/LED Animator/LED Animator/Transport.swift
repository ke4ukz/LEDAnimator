//
//  Transport.swift
//  LED Animator
//
//  Abstracts how the text control protocol gets to/from a device, so the same
//  DeviceSession can run over Bluetooth (BLEController) or Wi-Fi/TCP later.
//

import Foundation

/// A connection that carries the text control protocol to/from one device.
/// `DeviceSession` talks only to this, so it's identical over BLE or Wi‑Fi/TCP.
protocol DeviceTransport: AnyObject {
    /// Send one command line. `expectResponse` maps to the BLE write type; other
    /// transports can ignore it.
    func send(_ line: String, expectResponse: Bool)
    /// Tear down the connection.
    func disconnect()
}
