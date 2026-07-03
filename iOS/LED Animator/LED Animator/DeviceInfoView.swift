//
//  DeviceInfoView.swift
//  LED Animator
//
//  Presented from the control screen; shows what the device reported.
//

import SwiftUI

struct DeviceInfoView: View {
    let ble: BLEController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                LabeledContent("Name", value: ble.connectedName)
                LabeledContent("Platform", value: ble.platform ?? "—")
                LabeledContent("Firmware", value: ble.firmwareVersion ?? "—")
                if let count = ble.ledCount {
                    LabeledContent("LEDs", value: "\(count)")
                }
                if let free = ble.freeBytes {
                    LabeledContent("Free space", value: formatBytes(free))
                }
            }
            .navigationTitle("Device Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
