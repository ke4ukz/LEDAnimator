//
//  LEDProtocol.swift
//  LED Animator
//
//  BLE identifiers and the text control protocol spoken by the firmware
//  (see web/src/export/rp2040.ts). Kept transport-agnostic so the same command
//  strings will back Wi-Fi/USB transports later.
//

import CoreBluetooth

enum LEDGATT {
    /// Custom service advertised by our devices — the app scans/filters on THIS.
    /// The name is user-settable and the UART char UUIDs are shared, so only the
    /// service UUID uniquely identifies an LED Animator device.
    static let service = CBUUID(string: "4C454441-0001-4000-8000-4C4544415254")
    /// Write commands here (one text command per write).
    static let rx = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    /// Replies arrive as notifications here.
    static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
}

/// The subset of firmware commands v1 uses. One command == one BLE write.
enum LEDCommand {
    case info
    case list
    case select(String)
    case bright(Int)   // 0–100

    var text: String {
        switch self {
        case .info: return "INFO"
        case .list: return "LIST"
        case .select(let name): return "SELECT \(name)"
        case .bright(let value): return "BRIGHT \(value)"
        }
    }
}
