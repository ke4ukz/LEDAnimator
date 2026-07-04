//
//  HomeView.swift
//  LED Animator
//
//  The app's home shell for the unified authoring + control app. A sidebar with
//  two collapsible sections — your Animations (a mock library for now) and
//  discovered Devices — with the real device control reused from ControlView.
//  Opening the editor takes over the whole window; the editor + file-push flows
//  are placeholders/mocks until the native editor exists.
//

import SwiftUI

// MARK: - Mock animation library (placeholder data until real projects exist)

struct MockAnimation: Identifiable, Hashable {
    let id: String
    let name: String
    let tracks: [[Color]]   // one gradient per track (drives the segmented thumbnail)
    let ledCount: Int
    let frameCount: Int
    let fps: Int
    var duration: Double { fps > 0 ? Double(frameCount) / Double(fps) : 0 }
}

let sampleAnimations: [MockAnimation] = [
    MockAnimation(id: "rainbow", name: "Rainbow Cycle",
                  tracks: [[.red, .orange, .yellow, .green, .blue, .purple]],
                  ledCount: 60, frameCount: 120, fps: 30),
    MockAnimation(id: "fire", name: "Fire Flicker",
                  tracks: [[.red, .orange, .yellow], [.orange, .red]],
                  ledCount: 30, frameCount: 90, fps: 30),
    MockAnimation(id: "ocean", name: "Ocean Waves",
                  tracks: [[.teal, .blue], [.cyan, .teal], [.blue, .indigo]],
                  ledCount: 144, frameCount: 200, fps: 24),
    MockAnimation(id: "sparkle", name: "Sparkle",
                  tracks: [[.white, .blue, .white]],
                  ledCount: 50, frameCount: 60, fps: 30),
]

/// A stacked-band preview: one horizontal gradient per track, so more tracks
/// split the image into more (thinner) segments.
struct AnimationThumbnail: View {
    let tracks: [[Color]]
    var body: some View {
        VStack(spacing: 1) {
            ForEach(Array(tracks.enumerated()), id: \.offset) { _, colors in
                LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
            }
        }
        .background(.black)   // shows through the 1pt gaps as thin dividers
    }
}

private enum HomeSelection: Hashable {
    case animation(String)
    case device(String)
}

// MARK: - Home

struct HomeView: View {
    let ble: BLEController
    let wifi: TCPController
    let discovery: WiFiDiscovery

    @State private var selection: HomeSelection?
    @State private var showEditor = false          // full-screen editor takeover
    @State private var editingTitle = "Untitled Animation"
    @State private var animationsExpanded = true
    @State private var devicesExpanded = true
    @State private var animations = sampleAnimations

    private var devices: [UnifiedDevice] {
        mergeUnifiedDevices(ble: ble.devices, wifi: discovery.devices)
    }
    private var activeSession: DeviceSession? { ble.session ?? wifi.session }

    var body: some View {
        ZStack {
            if showEditor {
                // The editor REPLACES home (not an overlay) so the split view and
                // its window toolbar — the sidebar toggle, the Wi-Fi/Info buttons —
                // are gone entirely. A true full-window authoring surface.
                EditorView(title: editingTitle, onClose: { showEditor = false })
                    .transition(.move(edge: .bottom))
            } else {
                home
            }
        }
        .animation(.snappy(duration: 0.28), value: showEditor)
    }

    private var home: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        } detail: {
            detail
        }
        .onAppear { ble.startScan() }
        .onDisappear { ble.stopScan() }
        .task {
            while !Task.isCancelled {
                discovery.scan()
                try? await Task.sleep(for: .seconds(4))
            }
        }
        .onChange(of: selection) { _, sel in
            if case .device(let id) = sel { connect(to: id) }
        }
        .alert("Couldn't Connect", isPresented: failedBinding) {
            Button("OK", role: .cancel) { ble.clearFailure(); wifi.clearFailure() }
        } message: {
            Text(failureMessage)
        }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $selection) {
            Section(isExpanded: $animationsExpanded) {
                ForEach(animations) { a in
                    AnimationRow(animation: a)
                        .tag(HomeSelection.animation(a.id))
                        .contextMenu {   // right-click (Mac) / long-press (iOS)
                            Button(role: .destructive) { delete(a) } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
                .onDelete { deleteAnimations(at: $0) }   // swipe-to-delete
            } header: {
                sectionHeader("Animations") {
                    Button { editingTitle = "Untitled Animation"; showEditor = true } label: { Image(systemName: "plus") }
                        .buttonStyle(.borderless)
                        .help("New animation")
                }
            }

            Section(isExpanded: $devicesExpanded) {
                if devices.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Searching…").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(devices) { d in
                        HomeDeviceRow(device: d, connecting: connecting(d)).tag(HomeSelection.device(d.id))
                    }
                }
            } header: {
                sectionHeader("Devices") {
                    Button { ble.startScan(); discovery.scan() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help("Rescan for devices")
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("LED Animator")
    }

    private func sectionHeader<Trailing: View>(_ title: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack {
            Text(title)
            Spacer()
            trailing()
        }
    }

    // MARK: Animation deletion

    private func deleteAnimations(at offsets: IndexSet) {
        let ids = offsets.map { animations[$0].id }
        animations.remove(atOffsets: offsets)
        clearSelectionIfDeleted(ids)
    }

    private func delete(_ animation: MockAnimation) {
        animations.removeAll { $0.id == animation.id }
        clearSelectionIfDeleted([animation.id])
    }

    /// Drop the detail pane if the selected animation was just deleted.
    private func clearSelectionIfDeleted(_ ids: [String]) {
        if case .animation(let id) = selection, ids.contains(id) { selection = nil }
    }

    // MARK: Detail

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .animation(let id):
            if let a = animations.first(where: { $0.id == id }) {
                AnimationDetailView(animation: a, devices: devices,
                                    onEdit: { editingTitle = a.name; showEditor = true })
            }
        case .device:
            if let session = activeSession {
                ControlView(session: session)
            } else if isConnecting {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting…").foregroundStyle(.secondary)
                }
            } else {
                ContentUnavailableView("Not Connected", systemImage: "wifi.slash",
                                       description: Text("Select the device again to reconnect."))
            }
        case nil:
            ContentUnavailableView {
                Label("LED Animator", systemImage: "sparkles")
            } description: {
                Text("Pick an animation to edit or send, or a device to control.")
            }
        }
    }

    // MARK: Device connection (reuses the verified controllers)

    private var isConnecting: Bool {
        ble.connectionState == .connecting || wifi.connectionState == .connecting
    }

    private func connect(to id: String) {
        ble.disconnect()
        wifi.disconnect()
        guard let device = devices.first(where: { $0.id == id }) else { return }
        if let w = device.wifi {
            wifi.connect(host: w.host, name: w.displayName)
        } else if let b = device.ble {
            ble.connect(b)
        }
    }

    private func connecting(_ device: UnifiedDevice) -> Bool {
        if let b = device.ble, ble.connectionState == .connecting, ble.connectingName == b.name { return true }
        if device.wifi != nil, wifi.connectionState == .connecting, selection == .device(device.id) { return true }
        return false
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

// MARK: - Rows

private struct AnimationRow: View {
    let animation: MockAnimation
    var body: some View {
        HStack(spacing: 10) {
            AnimationThumbnail(tracks: animation.tracks)
                .frame(width: 34, height: 24)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(.white.opacity(0.15)))
            VStack(alignment: .leading, spacing: 1) {
                Text(animation.name)
                Text(animation.tracks.count == 1 ? "\(animation.ledCount) LEDs"
                                                  : "\(animation.ledCount) LEDs · \(animation.tracks.count) tracks")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct HomeDeviceRow: View {
    let device: UnifiedDevice
    let connecting: Bool
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lightbulb.fill").foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                if let ip = device.wifi?.host {
                    Text(ip).font(.caption2).foregroundStyle(.secondary)
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

// MARK: - Animation detail

private struct AnimationDetailView: View {
    let animation: MockAnimation
    let devices: [UnifiedDevice]
    let onEdit: () -> Void
    @State private var showSend = false

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                AnimationThumbnail(tracks: animation.tracks)
                    .frame(height: 150)
                    .frame(maxWidth: 520)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                VStack(spacing: 14) {
                    HStack(spacing: 28) {
                        metric("\(animation.ledCount)", "LEDs")
                        metric("\(animation.tracks.count)", animation.tracks.count == 1 ? "Track" : "Tracks")
                        metric("\(animation.frameCount)", "Frames")
                        metric(String(format: "%.1fs", animation.duration), "Length")
                    }

                    HStack(spacing: 12) {
                        Button { onEdit() } label: {
                            Label("Edit", systemImage: "slider.horizontal.3")
                        }
                        .buttonStyle(.borderedProminent)

                        Button { showSend = true } label: {
                            Label("Send to Device", systemImage: "arrow.up.circle")
                        }
                        .buttonStyle(.bordered)
                        .disabled(devices.isEmpty)
                    }
                    if devices.isEmpty {
                        Text("No devices found yet — connect one to send this.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .navigationTitle(animation.name)
        .inlineNavTitle()
        .sheet(isPresented: $showSend) {
            SendToDeviceView(animation: animation, devices: devices)
        }
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.bold().monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Send-to-device (mock push)

private struct SendToDeviceView: View {
    let animation: MockAnimation
    let devices: [UnifiedDevice]
    @Environment(\.dismiss) private var dismiss
    @State private var sendingTo: String?
    @State private var sentTo: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Send “\(animation.name)” to a device:")
                        .foregroundStyle(.secondary)
                }
                Section {
                    if devices.isEmpty {
                        Text("No devices found.").foregroundStyle(.secondary)
                    } else {
                        ForEach(devices) { d in
                            Button { mockSend(d) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "lightbulb.fill").foregroundStyle(.tint)
                                    Text(d.name).foregroundStyle(.primary)
                                    Spacer()
                                    if sendingTo == d.id {
                                        ProgressView().controlSize(.small)
                                    } else if sentTo == d.id {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(sendingTo != nil)
                        }
                    }
                }
            }
            .navigationTitle("Send to Device")
            .inlineNavTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .macSheetFrame()
    }

    // Placeholder: the real send will encode the pattern and upload over Wi-Fi.
    private func mockSend(_ device: UnifiedDevice) {
        sentTo = nil
        sendingTo = device.id
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            sendingTo = nil
            sentTo = device.id
        }
    }
}
