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

/// The firmware commands the app uses. One command == one BLE write.
enum LEDCommand {
    case info
    case moreInfo              // static/rarely-used details for the Info tab
    case list
    case select(String)
    case delete(String)        // remove a pattern file (not the active one)
    case bright(Int)            // 0–100
    case speed(Int)            // 10–400 (percent; 100 = as authored)
    case solid(Int, Int, Int)  // r, g, b — each 0–255
    case off                   // blank the strip
    case play                  // resume the selected pattern
    case setName(String)       // rename the device (persists on the board)
    case version
    case platform
    case free
    case power                 // live power status (USB present + VSYS mV)
    case setPin(Int)           // re-point the strip's data GP pin (0–29)
    case reboot                // warm-restart the device (re-advertises the BLE name)
    case whiteBalance(Int, Int, Int) // WHITEBAL r g b — set the canonical-white gains
    case queryWhiteBalance     // WHITEBAL — read the current white-balance gains
    // Multi-device sync
    case program(Int)          // group jukebox: play program n (a leader switches the whole group)
    case teardown              // leader-only: gracefully end the group
    case setLoss(String)       // follower on-sync-loss policy: indicate / silent / blackout
    case setStartup(String)    // follower boot behavior: wait / go
    // Auth (see docs/config-and-auth-plan.md)
    case login(String)         // LOGIN <sha256(pin+nonce) hex> — answer the NEEDPIN challenge
    case setPass(String)       // SETPASS <pin> — set/change the device PIN (authed only)
    case clearPass             // CLEARPASS — remove the PIN / unlock (authed only)
    // Wi-Fi provisioning (Pico W)
    case wifiScan              // stream nearby SSIDs
    case wifiSSID(String)      // stash the network name for the next connect
    case wifiPass(String)      // stash the password for the next connect
    case wifiConnect           // join with the stashed credentials + persist
    case wifiStatus            // query current Wi-Fi state
    case wifiForget            // clear saved credentials + disconnect

    var text: String {
        switch self {
        case .info: return "INFO"
        case .moreInfo: return "MOREINFO"
        case .list: return "LIST"
        case .select(let name): return "SELECT \(name)"
        case .delete(let name): return "DELETE \(name)"
        case .bright(let value): return "BRIGHT \(value)"
        case .speed(let value): return "SPEED \(value)"
        case .solid(let r, let g, let b): return "SOLID \(r) \(g) \(b)"
        case .off: return "OFF"
        case .play: return "PLAY"
        case .setName(let name): return "NAME \(name)"
        case .version: return "VERSION"
        case .platform: return "PLATFORM"
        case .free: return "FREE"
        case .power: return "POWER"
        case .setPin(let n): return "PIN \(n)"
        case .reboot: return "REBOOT"
        case .whiteBalance(let r, let g, let b): return "WHITEBAL \(r) \(g) \(b)"
        case .queryWhiteBalance: return "WHITEBAL"
        case .program(let n): return "PROGRAM \(n)"
        case .teardown: return "TEARDOWN"
        case .setLoss(let s): return "LOSS \(s)"
        case .setStartup(let s): return "STARTUP \(s)"
        case .login(let h): return "LOGIN \(h)"
        case .setPass(let pin): return "SETPASS \(pin)"
        case .clearPass: return "CLEARPASS"
        case .wifiScan: return "WIFISCAN"
        case .wifiSSID(let ssid): return "WIFISSID \(ssid)"
        case .wifiPass(let pass): return "WIFIPASS \(pass)"
        case .wifiConnect: return "WIFICONNECT"
        case .wifiStatus: return "WIFISTATUS"
        case .wifiForget: return "WIFIFORGET"
        }
    }
}

/// A network from a WIFISCAN, strongest first.
struct WiFiNetwork: Identifiable, Equatable {
    var ssid: String
    var rssi: Int   // dBm (negative; closer to 0 = stronger)
    var id: String { ssid }
}
