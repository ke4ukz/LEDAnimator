//
//  DeviceListView.swift
//  LED Animator
//
//  Scans for LED Animator devices and lets you connect to one.
//

import SwiftUI

#if os(iOS)
// The push-navigation device list is the iOS layout; macOS uses MacRootView's
// sidebar instead (see ContentView.swift). Shared helpers/types below are not
// gated, so both platforms use them.
/// iOS device browser: lists discovered devices (BLE scan + Wi-Fi/Bonjour) as a
/// list or a tile grid, connects on tap, and pushes `ControlView` once connected.
struct DeviceListView: View {
    let ble: BLEController
    let wifi: TCPController
    let discovery: WiFiDiscovery
    /// List vs. tile layout, persisted across launches via the toolbar toggle.
    @AppStorage("deviceTiles") private var tiles = false

    var body: some View {
        content
            .navigationTitle("LED Animator")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        tiles.toggle()
                    } label: {
                        Image(systemName: tiles ? "list.bullet" : "square.grid.2x2")
                    }
                    .help(tiles ? "Show as a list" : "Show as tiles")
                }
            }
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

    /// Picks the list or tile-grid presentation based on `tiles`.
    @ViewBuilder
    private var content: some View {
        if tiles { tileGrid } else { deviceList }
    }

    /// The list layout: one tappable row per device (or a "Searching…" row when
    /// none found), with a pull-to-refresh rescan and a Bluetooth-off footer hint.
    private var deviceList: some View {
        List {
            Section {
                if unifiedDevices.isEmpty {
                    searching
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

    /// The tile layout: an adaptive grid of device cards with the same tap-to-
    /// connect behavior, pull-to-refresh, and Bluetooth-off hint as the list.
    private var tileGrid: some View {
        ScrollView {
            if unifiedDevices.isEmpty {
                searching.frame(maxWidth: .infinity).padding(.top, 48)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    ForEach(unifiedDevices) { device in
                        Button {
                            connect(device)
                        } label: {
                            DeviceTile(device: device, connecting: connecting(device))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
            if !ble.bluetoothOn {
                Text("Bluetooth is off — only Wi-Fi devices will appear.")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal).padding(.bottom)
            }
        }
        .refreshable { ble.startScan(); discovery.scan() }
    }

    /// The spinner + "Searching…" placeholder shown while no devices are found.
    private var searching: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Searching…").foregroundStyle(.secondary)
        }
    }

    /// BLE + Wi-Fi discoveries collapsed into one row per physical device.
    private var unifiedDevices: [UnifiedDevice] {
        mergeUnifiedDevices(ble: ble.devices, wifi: discovery.devices)
    }

    /// Connect to a tapped device: Wi-Fi if it's on the network, else BLE.
    private func connect(_ device: UnifiedDevice) {
        if let w = device.wifi {
            wifi.connect(host: w.host, name: w.displayName)
        } else if let b = device.ble {
            ble.connect(b)
        }
    }

    /// Whether this row's device is the one currently connecting over BLE
    /// (drives its per-row spinner). Wi-Fi connects fast enough to skip.
    private func connecting(_ device: UnifiedDevice) -> Bool {
        guard let b = device.ble else { return false }
        return ble.connectionState == .connecting && ble.connectingName == b.name
    }

    /// The live session from whichever transport is connected.
    private var activeSession: DeviceSession? { ble.session ?? wifi.session }

    /// Drives the `navigationDestination` push: true while connected, and setting
    /// it false (pop / swipe-back) disconnects both transports.
    private var connectedBinding: Binding<Bool> {
        Binding(
            get: { ble.connectionState == .connected || wifi.connectionState == .connected },
            set: { if !$0 { ble.disconnect(); wifi.disconnect() } }
        )
    }

    /// True when a connection state is `.failed` (its message is unused here).
    private func isFailed(_ state: ConnectionState) -> Bool {
        if case .failed = state { true } else { false }
    }

    /// Presentation binding for the "Couldn't Connect" alert: on when either
    /// transport failed, and dismissing clears both failures.
    private var failedBinding: Binding<Bool> {
        Binding(
            get: { isFailed(ble.connectionState) || isFailed(wifi.connectionState) },
            set: { if !$0 { ble.clearFailure(); wifi.clearFailure() } }
        )
    }

    /// The failure text to show in the alert, from whichever transport failed.
    private var failureMessage: String {
        if case let .failed(message) = ble.connectionState { message }
        else if case let .failed(message) = wifi.connectionState { message }
        else { "" }
    }
}

/// A device as a card, for the tiles layout.
private struct DeviceTile: View {
    let device: UnifiedDevice
    let connecting: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "lightbulb.fill")
                .font(.system(size: 32))
                .foregroundStyle(.tint)
            Text(device.name)
                .font(.callout)
                .lineLimit(1)
                .multilineTextAlignment(.center)
            Text(device.wifi?.host ?? "Bluetooth")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if connecting {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.secondary.opacity(0.25)))
        .overlay(alignment: .topTrailing) {
            if device.isBTOnly {
                BluetoothBadge().padding(7)
            }
        }
    }
}
#endif

/// One row per physical device: a Wi-Fi discovery and a BLE discovery with the
/// same device id (the advert MAC / hostname suffix) collapse together, Wi-Fi
/// preferred. Shared by the iOS list and the macOS sidebar.
func mergeUnifiedDevices(ble: [DiscoveredDevice], wifi: [DiscoveredWiFiDevice]) -> [UnifiedDevice] {
    var map: [String: UnifiedDevice] = [:]
    var order: [String] = []
    /// Create the merged entry for `key` on first sight, preserving arrival order.
    func slot(_ key: String, _ name: String) {
        if map[key] == nil { map[key] = UnifiedDevice(id: key, name: name); order.append(key) }
    }
    for w in wifi {   // Wi-Fi first (preferred)
        let key = w.deviceID ?? "wifi:" + w.hostname
        slot(key, w.displayName)
        map[key]?.wifi = w
        map[key]?.name = w.displayName
    }
    for b in ble {
        let key = b.deviceID ?? "ble:" + b.id.uuidString
        slot(key, b.name)
        map[key]?.ble = b
        if map[key]?.wifi == nil { map[key]?.name = b.name }
    }
    return order.compactMap { map[$0] }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
}

/// The Bluetooth "ᛒ" bind-rune, drawn as a vector (no SF Symbol / asset exists).
/// A single stroke: two crossing diagonals + the mast + the two right-flag edges.
private struct BluetoothLogo: Shape {
    /// Traces the rune in a single connected stroke, normalized to `rect`.
    func path(in rect: CGRect) -> Path {
        /// Maps unit (0…1) coordinates to a point inside `rect`.
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
struct BluetoothBadge: View {
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
    /// Stable merge key: the shared device id (advert MAC / hostname suffix),
    /// or a transport-prefixed fallback when a device exposes no id.
    var id: String
    /// Display name, preferring the Wi-Fi advertised name when both are present.
    var name: String
    /// The Wi-Fi/Bonjour discovery, if seen on the network.
    var wifi: DiscoveredWiFiDevice?
    /// The BLE discovery, if seen over Bluetooth.
    var ble: DiscoveredDevice?
    /// Only reachable over Bluetooth right now (not seen on the network).
    var isBTOnly: Bool { wifi == nil }
}

#if os(iOS)
/// A device row in the iOS list: bulb icon, name, IP subtitle on Wi-Fi, a
/// Bluetooth badge when BT-only, and a trailing chevron or connecting spinner.
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
#endif
