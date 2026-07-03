//
//  DeviceInfoView.swift
//  LED Animator
//
//  Presented from the control screen; shows what the device reported and lets
//  you rename it.
//

import SwiftUI

struct DeviceInfoView: View {
    let ble: BLEController
    @Environment(\.dismiss) private var dismiss
    @State private var showRename = false
    @State private var editingName = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Name") {
                    HStack {
                        Text(ble.connectedName)
                        Spacer()
                        Button {
                            editingName = ble.connectedName
                            showRename = true
                        } label: {
                            Image(systemName: "pencil")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Rename device")
                    }
                }

                Section {
                    LabeledContent("Platform", value: display(ble.platform))
                    LabeledContent("Firmware", value: display(ble.firmwareVersion))
                    LabeledContent("LEDs", value: display(ble.ledCount.map(String.init)))
                    LabeledContent("Free space", value: display(ble.freeBytes.map(formatBytes)))
                }

                Section("Network") {
                    LabeledContent("Hostname", value: display(ble.hostname))
                    LabeledContent("Wi-Fi MAC", value: display(ble.wifiMac))
                    LabeledContent("Bluetooth", value: display(ble.bluetoothMac))
                }
            }
            .navigationTitle("Device Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Rename Device", isPresented: $showRename) {
                TextField("Name", text: $editingName)
                    .textInputAutocapitalization(.words)
                Button("Cancel", role: .cancel) { }
                Button("OK", action: commitRename)
            } message: {
                Text("Up to 26 characters. Saved on the device and used as its Bluetooth name.")
            }
            .onAppear { ble.requestMoreInfo() }
        }
    }

    /// A value if we have one; otherwise "Loading" until the MOREINFO batch
    /// completes, then "N/A" for anything the device didn't report.
    private func display(_ value: String?) -> String {
        if let value { return value }
        return ble.moreInfoLoaded ? "N/A" : "Loading…"
    }

    private func commitRename() {
        let trimmed = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != ble.connectedName else { return }
        ble.rename(trimmed)
    }

    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
