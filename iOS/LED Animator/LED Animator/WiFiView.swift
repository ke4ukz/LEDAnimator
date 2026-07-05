//
//  WiFiView.swift
//  LED Animator
//
//  Provision the device's Wi-Fi over BLE: scan or type a network, join, and see
//  the connection status. On iOS it's a sheet; on macOS it's the content of an
//  inspector panel (no sheet chrome).
//

import SwiftUI

/// Wi-Fi provisioning UI: shows connection status, lets you scan for or type a
/// network, join it, and forget it. Credentials are entered here but sent (and
/// persisted) by the device over the BLE control link. iOS presents it as a
/// sheet; macOS renders the bare list as an inspector panel.
struct WiFiView: View {
    /// The connected device being provisioned.
    let session: DeviceSession
    @Environment(\.dismiss) private var dismiss
    /// Editable SSID — seeded by tapping a scanned network, or typed directly.
    @State private var ssid = ""
    /// Editable password (blank = open network).
    @State private var password = ""

    /// Bare list on macOS (inspector); wrapped in a NavigationStack with a Done
    /// button on iOS (sheet).
    var body: some View {
        #if os(macOS)
        wifiList   // rendered as an inspector panel
        #else
        NavigationStack {
            wifiList
                .navigationTitle("Wi-Fi")
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

    /// The shared list body (status / join form / nearby networks / forget),
    /// reused by both the iOS sheet and the macOS inspector. Requests current
    /// Wi-Fi status on appear.
    private var wifiList: some View {
        List {
            Section("Status") {
                HStack(spacing: 12) {
                    Image(systemName: statusIcon)
                        .foregroundStyle(statusTint)
                        .imageScale(.large)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusText)
                        if !statusDetail.isEmpty {
                            Text(statusDetail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section {
                TextField("Network name (SSID)", text: $ssid)
                    .autocap(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                Button("Connect", action: connect)
                    .disabled(ssid.trimmingCharacters(in: .whitespaces).isEmpty)
            } header: {
                Text("Join a network")
            } footer: {
                Text("Leave the password blank for an open network. Credentials are saved on the device and re-joined on boot.")
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Nearby networks") {
                if session.isScanningWifi {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Scanning…").foregroundStyle(.secondary)
                    }
                } else {
                    Button {
                        session.scanWifi()
                    } label: {
                        Label("Scan for networks", systemImage: "arrow.clockwise")
                    }
                }
                ForEach(session.wifiNetworks) { net in
                    Button {
                        ssid = net.ssid
                    } label: {
                        HStack {
                            Text(net.ssid).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "wifi", variableValue: signalFraction(net.rssi))
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if session.wifiState == "connected" || session.wifiState == "connecting" {
                Section {
                    Button("Forget network", role: .destructive) {
                        session.forgetWifi()
                    }
                }
            }
        }
        .onAppear { session.requestWifiStatus() }
    }

    /// Send the entered credentials for the device to join and persist.
    private func connect() {
        session.connectWifi(ssid: ssid, password: password)
    }

    /// The status row's headline for the current `wifiState`.
    private var statusText: String {
        switch session.wifiState {
        case "connected": return "Connected"
        case "connecting": return "Connecting…"
        case "failed": return "Couldn't connect"
        default: return "Not connected"
        }
    }

    /// The IP when connected, or a human reason when failed.
    private var statusDetail: String {
        switch session.wifiState {
        case "connected": return session.wifiDetail.isEmpty ? "" : "IP \(session.wifiDetail)"
        case "failed":
            switch session.wifiDetail {
            case "wrong-password": return "Wrong password"
            case "no-ap": return "Network not found"
            default: return "Try again"
            }
        default: return ""
        }
    }

    /// SF Symbol matching the current Wi-Fi state.
    private var statusIcon: String {
        switch session.wifiState {
        case "connected": return "wifi"
        case "connecting": return "wifi"
        case "failed": return "wifi.exclamationmark"
        default: return "wifi.slash"
        }
    }

    /// Tint for the status icon: green connected, orange failed, muted otherwise.
    private var statusTint: Color {
        switch session.wifiState {
        case "connected": return .green
        case "failed": return .orange
        default: return .secondary
        }
    }

    /// Map an RSSI (dBm) to 0…1 so the "wifi" symbol fills its arcs by strength
    /// (≈ −50 dBm or better = full, ≈ −90 dBm = empty).
    private func signalFraction(_ rssi: Int) -> Double {
        min(1, max(0, Double(rssi + 90) / 40))
    }
}
