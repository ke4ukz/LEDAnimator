//
//  DeviceListView.swift
//  LED Animator
//
//  Scans for LED Animator devices and lets you connect to one.
//

import SwiftUI

struct DeviceListView: View {
    let ble: BLEController

    var body: some View {
        List {
            if !ble.bluetoothOn {
                ContentUnavailableView(
                    "Bluetooth Off",
                    systemImage: "antenna.radiowaves.left.and.right.slash",
                    description: Text("Turn on Bluetooth to find your LED devices.")
                )
            } else if ble.devices.isEmpty {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Searching for LED devices…")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("Devices") {
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
        .navigationTitle("LED Devices")
        .navigationDestination(isPresented: connectedBinding) {
            ControlView(ble: ble)
        }
        .alert("Couldn't Connect", isPresented: failedBinding) {
            Button("OK", role: .cancel) { ble.clearFailure() }
        } message: {
            Text(failureMessage)
        }
        .onAppear { ble.startScan() }
        .onDisappear { ble.stopScan() }
        .refreshable { ble.startScan() }
    }

    private func connecting(_ device: DiscoveredDevice) -> Bool {
        ble.connectionState == .connecting && ble.connectedName == device.name
    }

    private var connectedBinding: Binding<Bool> {
        Binding(
            get: { ble.connectionState == .connected },
            set: { if !$0 { ble.disconnect() } }
        )
    }

    private var failedBinding: Binding<Bool> {
        Binding(
            get: { if case .failed = ble.connectionState { true } else { false } },
            set: { if !$0 { ble.clearFailure() } }
        )
    }

    private var failureMessage: String {
        if case let .failed(message) = ble.connectionState { message } else { "" }
    }
}

private struct DeviceRow: View {
    let device: DiscoveredDevice
    let connecting: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                Text("\(device.rssi) dBm")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
