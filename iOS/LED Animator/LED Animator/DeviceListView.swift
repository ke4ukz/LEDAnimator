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
    @State private var showWifiConnect = false
    @State private var wifiIP = ""

    var body: some View {
        content
            .navigationTitle("Devices")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showWifiConnect = true } label: { Image(systemName: "wifi") }
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
            .sheet(isPresented: $showWifiConnect) { wifiConnectSheet }
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

    private var wifiConnectSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Device IP address", text: $wifiIP)
                        .keyboardType(.numbersAndPunctuation)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text("For a device that doesn't appear in the list (e.g. on a network that blocks discovery).")
                }
            }
            .navigationTitle("Connect over Wi-Fi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showWifiConnect = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        showWifiConnect = false
                        wifi.connect(host: wifiIP)
                    }
                    .disabled(wifiIP.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var content: some View {
        List {
            Section("On Your Network") {
                if discovery.devices.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Searching over Wi-Fi…").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(discovery.devices) { device in
                        Button {
                            wifi.connect(host: device.host, name: device.displayName)
                        } label: {
                            WiFiDeviceRow(device: device)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            Section("Nearby (Bluetooth)") {
                if !ble.bluetoothOn {
                    Text("Bluetooth is off.").foregroundStyle(.secondary)
                } else if ble.devices.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Searching…").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(ble.devices) { device in
                        Button {
                            ble.connect(device)
                        } label: {
                            DeviceRow(device: device, connecting: connecting(device))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .refreshable { ble.startScan(); discovery.scan() }
    }

    private func connecting(_ device: DiscoveredDevice) -> Bool {
        ble.connectionState == .connecting && ble.connectingName == device.name
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

private struct WiFiDeviceRow: View {
    let device: DiscoveredWiFiDevice

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.tint)
            Image(systemName: "wifi")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.displayName)
                Text(device.host)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

private struct DeviceRow: View {
    let device: DiscoveredDevice
    let connecting: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.tint)
            Image(systemName: "cellularbars", variableValue: signalFraction(device.rssi))
                .foregroundStyle(.secondary)
            Text(device.name)
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

    /// Maps RSSI to 0–1 for the variable-value bars (~-50 dBm strong → full,
    /// ~-90 dBm weak → roughly one bar).
    private func signalFraction(_ rssi: Int) -> Double {
        let clamped = Double(min(-50, max(-90, rssi)))
        return max(0.2, (clamped + 90) / 40)
    }
}
