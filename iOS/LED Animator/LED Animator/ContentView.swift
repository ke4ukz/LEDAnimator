//
//  ContentView.swift
//  LED Animator
//

import SwiftUI

/// App root. Owns the three long-lived controllers (BLE, Wi-Fi/TCP, Bonjour
/// discovery) and hands them to the platform-appropriate layout: a split-view
/// sidebar on macOS, a push-navigation stack on iOS.
struct ContentView: View {
    /// Bluetooth scanning + connection/session for BLE devices.
    @State private var ble = BLEController()
    /// TCP transport used once connected over Wi-Fi (also handles uploads).
    @State private var wifi = TCPController()
    /// Bonjour browser that surfaces devices reachable on the local network.
    @State private var discovery = WiFiDiscovery()

    var body: some View {
        #if os(macOS)
        // Native Mac layout: devices in a persistent sidebar, controls in the
        // detail pane. (iOS uses a push-navigation stack instead.)
        MacRootView(ble: ble, wifi: wifi, discovery: discovery)
        #else
        NavigationStack {
            DeviceListView(ble: ble, wifi: wifi, discovery: discovery)
        }
        #endif
    }
}

#if os(macOS)
/// macOS root: a NavigationSplitView with a device sidebar and a control detail
/// pane. Selecting a device in the sidebar connects to it; the detail shows the
/// live controls for the connected session (or a placeholder when none).
struct MacRootView: View {
    let ble: BLEController
    let wifi: TCPController
    let discovery: WiFiDiscovery

    /// The selected sidebar row, keyed by `UnifiedDevice.id`; changing it drives
    /// `connect(to:)`. nil means nothing selected (detail shows the placeholder).
    @State private var selection: String?   // UnifiedDevice.id

    /// BLE + Wi-Fi discoveries collapsed into one row per physical device.
    private var devices: [UnifiedDevice] {
        mergeUnifiedDevices(ble: ble.devices, wifi: discovery.devices)
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
        } detail: {
            detail
        }
        .frame(minWidth: 680, minHeight: 440)
        .onAppear { ble.startScan() }
        .onDisappear { ble.stopScan() }
        .task {
            // Keep probing while open so devices that join the network still show.
            while !Task.isCancelled {
                discovery.scan()
                try? await Task.sleep(for: .seconds(4))
            }
        }
        .onChange(of: selection) { _, id in connect(to: id) }
        .alert("Couldn't Connect", isPresented: failedBinding) {
            Button("OK", role: .cancel) { ble.clearFailure(); wifi.clearFailure() }
        } message: {
            Text(failureMessage)
        }
    }

    // MARK: Sidebar

    /// The device list column: selectable rows, a "Searching…" overlay (with a
    /// Bluetooth-off hint) when empty, and a toolbar rescan button.
    private var sidebar: some View {
        List(selection: $selection) {
            ForEach(devices) { device in
                MacSidebarDeviceRow(device: device, connecting: connecting(device))
                    .tag(device.id)
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if devices.isEmpty {
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Searching…").foregroundStyle(.secondary)
                    if !ble.bluetoothOn {
                        Text("Bluetooth is off — only Wi-Fi devices will appear.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding()
            }
        }
        .navigationTitle("Devices")
        .toolbar {
            ToolbarItem {
                Button {
                    ble.startScan()
                    discovery.scan()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Rescan for devices")
            }
        }
    }

    // MARK: Detail

    /// The detail pane: live controls for the connected session, a "Connecting…"
    /// spinner mid-connect, or an unavailable placeholder when nothing's selected.
    @ViewBuilder
    private var detail: some View {
        if let session = activeSession {
            ControlView(session: session)
        } else if isConnecting {
            VStack(spacing: 12) {
                ProgressView()
                Text("Connecting…").foregroundStyle(.secondary)
            }
        } else {
            ContentUnavailableView(
                "No Device Selected",
                systemImage: "lightbulb",
                description: Text("Choose a device from the sidebar to control it.")
            )
        }
    }

    // MARK: Connection

    /// The live session from whichever transport is connected (only one is at a time).
    private var activeSession: DeviceSession? { ble.session ?? wifi.session }

    /// True while either transport is mid-connect.
    private var isConnecting: Bool {
        ble.connectionState == .connecting || wifi.connectionState == .connecting
    }

    /// Switch the connection to the newly-selected device: tear down any current
    /// link first, then connect over Wi-Fi if available, else BLE. Called from
    /// `onChange(of: selection)`.
    private func connect(to id: String?) {
        // Tear down any current connection before opening a new one.
        ble.disconnect()
        wifi.disconnect()
        guard let id, let device = devices.first(where: { $0.id == id }) else { return }
        if let w = device.wifi {
            wifi.connect(host: w.host, name: w.displayName)
        } else if let b = device.ble {
            ble.connect(b)
        }
    }

    /// Whether this row's device is the one currently connecting (drives its
    /// per-row spinner). BLE matches by name; Wi-Fi matches the selected row.
    private func connecting(_ device: UnifiedDevice) -> Bool {
        if let b = device.ble, ble.connectionState == .connecting, ble.connectingName == b.name { return true }
        if device.wifi != nil, wifi.connectionState == .connecting, selection == device.id { return true }
        return false
    }

    // MARK: Failure alert

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

/// A device row in the macOS sidebar: no chevron (selection highlights it), an
/// IP subtitle when on Wi-Fi, and a Bluetooth badge when only reachable over BT.
private struct MacSidebarDeviceRow: View {
    let device: UnifiedDevice
    let connecting: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                if let ip = device.wifi?.host {
                    Text(ip)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if connecting {
                ProgressView().controlSize(.small)
            } else if device.isBTOnly {
                BluetoothBadge().accessibilityLabel("Bluetooth only")
            }
        }
        .padding(.vertical, 2)
    }
}
#endif

#Preview {
    ContentView()
}
