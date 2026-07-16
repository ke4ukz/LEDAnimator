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
    /// Drives the set/change-PIN alert.
    @State private var showPinEditor = false
    /// Scratch text for the new PIN.
    @State private var newPin = ""
    /// Confirms removing the PIN.
    @State private var showRemovePin = false
    /// Confirms a manual device restart.
    @State private var showRestart = false
    /// Presents the white-balance calibration pad.
    @State private var showWhiteBalance = false

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

            Section {
                Button("Calibrate White…") { showWhiteBalance = true }
            } header: {
                Text("Color")
            } footer: {
                Text("Tune the strip's white point so colors look like what you designed. Adjust it against the actual LEDs; it's saved on the device.")
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section {
                if session.pinIsSet {
                    LabeledContent("PIN protection", value: "On")
                    Button("Remove PIN", role: .destructive) { showRemovePin = true }
                } else {
                    LabeledContent("PIN protection", value: "Off")
                    Button("Set a PIN") { newPin = ""; showPinEditor = true }
                }
            } header: {
                Text("Security")
            } footer: {
                Text("A PIN asks anyone connecting to enter it before they can control this device. To change it, remove it and set a new one. It's a casual deterrent — someone with physical access can reset it.")
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
                        // "Automatic" == follow the animation's header (no device
                        // override, i.e. delete the config entry). A concrete value
                        // pins it as an override that wins over every animation.
                        Picker("Startup", selection: Binding(
                            get: { session.startupOverridden ? (session.startupPolicy ?? "wait") : "auto" },
                            set: { newVal in
                                if newVal == "auto" { session.revertStartup() }
                                else { session.setStartup(newVal) }
                            }
                        )) {
                            Text("Automatic (use animation)").tag("auto")
                            Text("Wait for sync").tag("wait")
                            Text("Start and go").tag("go")
                        }
                        .pickerStyle(.menu)
                        if !session.startupOverridden, let v = session.startupPolicy {
                            followingNote(startupLabel(v))
                        }
                        Picker("On sync loss", selection: Binding(
                            get: { session.lossOverridden ? (session.lossPolicy ?? "indicate") : "auto" },
                            set: { newVal in
                                if newVal == "auto" { session.revertLoss() }
                                else { session.setLossPolicy(newVal) }
                            }
                        )) {
                            Text("Automatic (use animation)").tag("auto")
                            Text("Keep playing · indicate").tag("indicate")
                            Text("Keep playing · silent").tag("silent")
                            Text("Blackout").tag("blackout")
                        }
                        .pickerStyle(.menu)
                        if !session.lossOverridden, let v = session.lossPolicy {
                            followingNote(lossLabel(v))
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

            Section {
                Button("Restart Device") { showRestart = true }
            } header: {
                Text("Maintenance")
            } footer: {
                Text("Restarts the controller. Your patterns and settings are kept — it reconnects in a few seconds.")
                    .fixedSize(horizontal: false, vertical: true)
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
        .alert("Set PIN", isPresented: $showPinEditor) {
            SecureField("PIN", text: $newPin)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
            Button("Cancel", role: .cancel) { newPin = "" }
            Button("Save", action: commitPin)
        } message: {
            Text("A 4–8 digit PIN. Saved on the device.")
        }
        .alert("Remove PIN?", isPresented: $showRemovePin) {
            Button("Remove", role: .destructive) { session.clearPin() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("The device will no longer ask for a PIN before letting anyone control it.")
        }
        .alert("Restart Device?", isPresented: $showRestart) {
            Button("Restart") { session.rebootDevice() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("The controller reboots and reconnects in a few seconds. Your patterns and settings are kept.")
        }
        .sheet(isPresented: $showWhiteBalance) {
            WhiteBalanceView(session: session)
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

    /// Caption under a policy picker set to Automatic, echoing what the current
    /// animation actually asks for (the effective value the device reports) — so
    /// "Automatic" isn't opaque about the behavior in effect right now.
    @ViewBuilder
    private func followingNote(_ value: String) -> some View {
        Text("Following the animation · \(value)")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// Menu-matching label for a loss policy value ("indicate"/"silent"/"blackout").
    private func lossLabel(_ v: String) -> String {
        switch v {
        case "silent": return "Keep playing · silent"
        case "blackout": return "Blackout"
        default: return "Keep playing · indicate"
        }
    }

    /// Menu-matching label for a startup policy value ("wait"/"go").
    private func startupLabel(_ v: String) -> String {
        v == "go" ? "Start and go" : "Wait for sync"
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
        // The device applies the name live across Wi-Fi discovery, the BLE advert, and
        // every connected client — no restart needed.
    }

    /// Apply a new PIN: keep digits only and require 4–8 of them (the firmware
    /// validates the same and returns ERR args otherwise).
    private func commitPin() {
        let digits = newPin.filter(\.isNumber)
        newPin = ""
        guard (4...8).contains(digits.count) else { return }
        session.setPin(digits)
    }

    /// Human-readable free space (e.g. "1.2 MB") for the raw byte count.
    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
