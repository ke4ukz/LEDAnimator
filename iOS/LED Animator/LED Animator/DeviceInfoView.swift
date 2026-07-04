//
//  DeviceInfoView.swift
//  LED Animator
//
//  Shows what the device reported and lets you rename it. On iOS it's a sheet;
//  on macOS it's the content of an inspector panel (no sheet chrome).
//

import SwiftUI

struct DeviceInfoView: View {
    let session: DeviceSession
    @Environment(\.dismiss) private var dismiss
    @State private var showRename = false
    @State private var editingName = ""

    var body: some View {
        #if os(macOS)
        infoList   // rendered as an inspector panel
        #else
        NavigationStack {
            infoList
                .navigationTitle("Device Info")
                .inlineNavTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .macSheetFrame()
        #endif
    }

    private var infoList: some View {
        List {
            Section("Name") {
                HStack {
                    Text(session.connectedName)
                    Spacer()
                    Button {
                        editingName = session.connectedName
                        showRename = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Rename device")
                }
            }

            Section {
                LabeledContent("Platform", value: display(session.platform))
                LabeledContent("Firmware", value: display(session.firmwareVersion))
                LabeledContent("LEDs", value: display(session.ledCount.map(String.init)))
                LabeledContent("Free space", value: display(session.freeBytes.map(formatBytes)))
            }

            Section {
                if let pin = session.dataPin {
                    Picker("Data pin", selection: Binding(
                        get: { pin },
                        set: { session.setDataPin($0) }
                    )) {
                        ForEach(0..<30, id: \.self) { n in
                            Text("GP\(n)").tag(n)
                        }
                    }
                    .pickerStyle(.menu)
                } else {
                    LabeledContent("Data pin", value: display(nil))
                }
            } header: {
                Text("Output")
            } footer: {
                Text("The GP pin your LED strip's data line is wired to. Changing it takes effect immediately and is saved on the device.")
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Power") {
                HStack(spacing: 12) {
                    Image(systemName: powerIcon.name)
                        .foregroundStyle(powerIcon.color)
                        .imageScale(.large)
                        .frame(width: 24)
                    Text(powerText)
                    Spacer()
                    if let volts = voltageText {
                        Text(volts).foregroundStyle(.secondary)
                    }
                }
            }

            Section("Network") {
                LabeledContent("Hostname", value: display(session.hostname))
                LabeledContent("Wi-Fi MAC", value: display(session.wifiMac))
                LabeledContent("Bluetooth", value: display(session.bluetoothMac))
            }
        }
        .alert("Rename Device", isPresented: $showRename) {
            TextField("Name", text: $editingName)
                .autocap(.words)
            Button("Cancel", role: .cancel) { }
            Button("OK", action: commitRename)
        } message: {
            Text("Up to 26 characters. Saved on the device and used as its Bluetooth name.")
        }
        .onAppear { session.requestMoreInfo() }
        .task {
            // Power drifts slowly; re-poll while the panel is open (the initial
            // value arrives in the MOREINFO batch).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled { break }
                session.requestPower()
            }
        }
    }

    /// Plug icon when on USB; a battery whose fill approximates the 1S LiPo
    /// charge (rough — VSYS sags under LED load), amber/red when it's getting low.
    private var powerIcon: (name: String, color: Color) {
        switch session.powerSource {
        case "usb": return ("powerplug.fill", .green)
        case "batt":
            guard let mv = session.vsysMillivolts else { return ("battery.100", .primary) }
            switch mv {
            case 3900...: return ("battery.100", .primary)
            case 3650..<3900: return ("battery.50", .primary)
            case 3450..<3650: return ("battery.25", .orange)
            default: return ("battery.0", .red)
            }
        default: return ("bolt.slash", .secondary)
        }
    }

    private var powerText: String {
        switch session.powerSource {
        case "usb": return "Plugged in"
        case "batt": return "On battery"
        case nil: return session.moreInfoLoaded ? "N/A" : "Loading…"
        default: return "N/A"
        }
    }

    /// Only shown on battery — on USB, VSYS is the ~4.7 V USB rail, not the pack.
    private var voltageText: String? {
        guard session.powerSource == "batt", let mv = session.vsysMillivolts else { return nil }
        return String(format: "%.2f V", Double(mv) / 1000)
    }

    /// A value if we have one; otherwise "Loading" until the MOREINFO batch
    /// completes, then "N/A" for anything the device didn't report.
    private func display(_ value: String?) -> String {
        if let value { return value }
        return session.moreInfoLoaded ? "N/A" : "Loading…"
    }

    private func commitRename() {
        let trimmed = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != session.connectedName else { return }
        session.rename(trimmed)
    }

    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
