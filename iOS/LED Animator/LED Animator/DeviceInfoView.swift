//
//  DeviceInfoView.swift
//  LED Animator
//
//  Shows what the device reported and lets you rename it. On iOS it's a sheet;
//  on macOS it's the content of an inspector panel (no sheet chrome).
//

import SwiftUI

/// Read-mostly device details (platform, firmware, LEDs, power, network) plus
/// the two writable knobs: rename and the strip's data GP pin. iOS presents it
/// as a sheet with its own nav chrome; macOS drops the chrome and renders the
/// bare list as an inspector panel.
struct DeviceInfoView: View {
    /// The connected device whose reported state we display.
    let session: DeviceSession
    @Environment(\.dismiss) private var dismiss
    /// Drives the rename alert.
    @State private var showRename = false
    /// Scratch text for the rename alert's field.
    @State private var editingName = ""

    /// Bare list on macOS (inspector); wrapped in a NavigationStack with a Done
    /// button on iOS (sheet).
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

    /// The shared list body (name/details/output/power/network sections). Split
    /// out so both the iOS sheet and the macOS inspector can reuse it. On appear
    /// it requests MOREINFO and starts a slow power-poll for the panel's lifetime.
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

            // Only shown for devices that are part of a sync group — a plain
            // standalone device has nothing multi-device to report.
            if let role = session.role, role != "standalone" {
                Section("Sync") {
                    LabeledContent("Role", value: role.capitalized)
                    LabeledContent("Group", value: display(session.syncGroup.map(String.init)))
                    LabeledContent("Device", value: display(session.deviceSlice.map(String.init)))
                    LabeledContent("Program", value: display(session.program.map(String.init)))
                    if role == "follower" || role == "auto" {
                        Picker("Startup", selection: Binding(
                            get: { session.startupPolicy ?? "wait" },
                            set: { session.setStartup($0) }
                        )) {
                            Text("Wait for sync").tag("wait")
                            Text("Start and go").tag("go")
                        }
                        .pickerStyle(.menu)
                        if session.startupOverridden {
                            overrideNote { session.revertStartup() }
                        }
                        Picker("On sync loss", selection: Binding(
                            get: { session.lossPolicy ?? "indicate" },
                            set: { session.setLossPolicy($0) }
                        )) {
                            Text("Keep playing · indicate").tag("indicate")
                            Text("Keep playing · silent").tag("silent")
                            Text("Blackout").tag("blackout")
                        }
                        .pickerStyle(.menu)
                        if session.lossOverridden {
                            overrideNote { session.revertLoss() }
                        }
                    }
                }
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

    /// The caption + revert control shown under a policy picker whose value is
    /// pinned as a device override — so the user sees this device is ignoring what
    /// its animation asks for, and can hand control back to the animation.
    @ViewBuilder
    private func overrideNote(revert: @escaping () -> Void) -> some View {
        HStack {
            Label("Overriding the animation", systemImage: "pin.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Use animation's setting", action: revert)
                .font(.caption)
                .buttonStyle(.borderless)
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

    /// The power row's label; "Loading…" until MOREINFO lands, then "N/A" if the
    /// board never reported a source.
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

    /// Apply the rename, ignoring an empty or unchanged name. (The session does
    /// its own ASCII filtering and 26-char cap.)
    private func commitRename() {
        let trimmed = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != session.connectedName else { return }
        session.rename(trimmed)
    }

    /// Human-readable free space (e.g. "1.2 MB") for the raw byte count.
    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
