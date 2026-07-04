//
//  ContentView.swift
//  LED Animator
//

import SwiftUI

struct ContentView: View {
    @State private var ble = BLEController()
    @State private var wifi = TCPController()
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

    @State private var selection: String?   // UnifiedDevice.id
    @State private var inspectorPanel: InspectorPanel?   // Info/Wi-Fi inspector

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
        // Attach the inspector here (not on the detail's List) so the Info/Wi-Fi
        // toolbar buttons stay in the detail's toolbar region and don't overflow
        // as the inspector column animates open from zero width.
        .inspector(isPresented: inspectorPresented) {
            Group {
                if let session = activeSession {
                    if inspectorPanel == .wifi {
                        WiFiView(session: session)
                    } else {
                        DeviceInfoView(session: session)
                    }
                }
            }
            .inspectorColumnWidth(min: 260, ideal: 300, max: 380)
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

    @ViewBuilder
    private var detail: some View {
        if let session = activeSession {
            ControlView(session: session, inspectorPanel: $inspectorPanel)
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

    private var activeSession: DeviceSession? { ble.session ?? wifi.session }

    private var isConnecting: Bool {
        ble.connectionState == .connecting || wifi.connectionState == .connecting
    }

    private var inspectorPresented: Binding<Bool> {
        Binding(
            get: { inspectorPanel != nil && activeSession != nil },
            set: { if !$0 { inspectorPanel = nil } }
        )
    }

    private func connect(to id: String?) {
        // Tear down any current connection before opening a new one.
        inspectorPanel = nil   // don't carry an open panel across devices
        ble.disconnect()
        wifi.disconnect()
        guard let id, let device = devices.first(where: { $0.id == id }) else { return }
        if let w = device.wifi {
            wifi.connect(host: w.host, name: w.displayName)
        } else if let b = device.ble {
            ble.connect(b)
        }
    }

    private func connecting(_ device: UnifiedDevice) -> Bool {
        if let b = device.ble, ble.connectionState == .connecting, ble.connectingName == b.name { return true }
        if device.wifi != nil, wifi.connectionState == .connecting, selection == device.id { return true }
        return false
    }

    // MARK: Failure alert

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
