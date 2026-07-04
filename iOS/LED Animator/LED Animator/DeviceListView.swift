//
//  DeviceListView.swift
//  LED Animator
//
//  Scans for LED Animator devices and lets you connect to one.
//

import SwiftUI

struct DeviceListView: View {
    let ble: BLEController
    let wifi: TCPController
    let discovery: WiFiDiscovery

    var body: some View {
        content
            .navigationTitle("Devices")
            #if os(macOS)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        ble.startScan()
                        discovery.scan()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            #endif
            .navigationDestination(isPresented: connectedBinding) {
                if let session = activeSession {
                    ControlView(session: session)
                }
            }
            .alert("Couldn't Connect", isPresented: failedBinding) {
                Button("OK", role: .cancel) { ble.clearFailure(); wifi.clearFailure() }
            } message: {
                Text(failureMessage)
            }
            .onAppear { ble.startScan() }
            .onDisappear { ble.stopScan() }
            .task {
                // Re-broadcast the discovery probe periodically while visible, so
                // a device that joins the network a moment later still appears.
                while !Task.isCancelled {
                    discovery.scan()
                    try? await Task.sleep(for: .seconds(4))
                }
            }
    }

    private var content: some View {
        List {
            Section {
                if unifiedDevices.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Searching…").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(unifiedDevices) { device in
                        Button {
                            connect(device)
                        } label: {
                            UnifiedDeviceRow(device: device, connecting: connecting(device))
                        }
                        .buttonStyle(.plain)
                    }
                }
            } header: {
                Text("Devices")
            } footer: {
                if !ble.bluetoothOn {
                    Text("Bluetooth is off — only Wi-Fi devices will appear.")
                }
            }
        }
        .refreshable { ble.startScan(); discovery.scan() }
    }

    /// One row per physical device: a Wi-Fi discovery and a BLE discovery with
    /// the same device id (the advert MAC / hostname suffix) collapse together,
    /// Wi-Fi preferred.
    private var unifiedDevices: [UnifiedDevice] {
        var map: [String: UnifiedDevice] = [:]
        var order: [String] = []
        func slot(_ key: String, _ name: String) -> Int {
            if map[key] == nil { map[key] = UnifiedDevice(id: key, name: name); order.append(key) }
            return 0
        }
        for w in discovery.devices {   // Wi-Fi first (preferred)
            let key = w.deviceID ?? "wifi:" + w.hostname
            _ = slot(key, w.displayName)
            map[key]?.wifi = w
            map[key]?.name = w.displayName
        }
        for b in ble.devices {
            let key = b.deviceID ?? "ble:" + b.id.uuidString
            _ = slot(key, b.name)
            map[key]?.ble = b
            if map[key]?.wifi == nil { map[key]?.name = b.name }
        }
        return order.compactMap { map[$0] }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func connect(_ device: UnifiedDevice) {
        if let w = device.wifi {
            wifi.connect(host: w.host, name: w.displayName)
        } else if let b = device.ble {
            ble.connect(b)
        }
    }

    private func connecting(_ device: UnifiedDevice) -> Bool {
        guard let b = device.ble else { return false }
        return ble.connectionState == .connecting && ble.connectingName == b.name
    }

    private var activeSession: DeviceSession? { ble.session ?? wifi.session }

    private var connectedBinding: Binding<Bool> {
        Binding(
            get: { ble.connectionState == .connected || wifi.connectionState == .connected },
            set: { if !$0 { ble.disconnect(); wifi.disconnect() } }
        )
    }

    private func isFailed(_ state: ConnectionState) -> Bool {
        if case .failed = state { true } else { false }
    }

    private var failedBinding: Binding<Bool> {
        Binding(
            get: { isFailed(ble.connectionState) || isFailed(wifi.connectionState) },
            set: { if !$0 { ble.clearFailure(); wifi.clearFailure() } }
        )
    }

    private var failureMessage: String {
        if case let .failed(message) = ble.connectionState { message }
        else if case let .failed(message) = wifi.connectionState { message }
        else { "" }
    }
}

/// The Bluetooth "ᛒ" bind-rune, drawn as a vector (no SF Symbol / asset exists).
/// A single stroke: two crossing diagonals + the mast + the two right-flag edges.
private struct BluetoothLogo: Shape {
    func path(in rect: CGRect) -> Path {
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
        }
        var path = Path()
        path.move(to: p(0.28, 0.25))      // upper-left
        path.addLine(to: p(0.72, 0.75))   // → lower-right (through center)
        path.addLine(to: p(0.50, 1.0))    // → mast bottom
        path.addLine(to: p(0.50, 0.0))    // → mast top
        path.addLine(to: p(0.72, 0.25))   // → upper-right
        path.addLine(to: p(0.28, 0.75))   // → lower-left (through center)
        return path
    }
}

/// White Bluetooth rune on the brand-blue rounded badge.
private struct BluetoothBadge: View {
    var body: some View {
        BluetoothLogo()
            .stroke(.white, style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
            .padding(4)
            .frame(width: 18, height: 18)
            .background(Color(red: 0.0, green: 0.42, blue: 0.9), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// One physical device, reachable over Wi-Fi and/or Bluetooth.
struct UnifiedDevice: Identifiable {
    var id: String
    var name: String
    var wifi: DiscoveredWiFiDevice?
    var ble: DiscoveredDevice?
    /// Only reachable over Bluetooth right now (not seen on the network).
    var isBTOnly: Bool { wifi == nil }
}

private struct UnifiedDeviceRow: View {
    let device: UnifiedDevice
    let connecting: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                if let ip = device.wifi?.host {
                    Text(ip)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if device.isBTOnly {
                BluetoothBadge()
                    .accessibilityLabel("Bluetooth only")
            }
            Spacer()
            if connecting {
                ProgressView()
            } else {
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
    }
}
