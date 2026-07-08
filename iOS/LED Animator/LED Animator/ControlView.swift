//
//  ControlView.swift
//  LED Animator
//
//  Connected device: live control (playback mode, brightness, speed, solid
//  color) plus picking which pattern plays.
//

import SwiftUI
import UniformTypeIdentifiers

/// The three device playback states, mapped to firmware commands.
private enum PlaybackMode: Hashable {
    case play   // run the selected pattern
    case solid  // hold a solid color
    case off    // blank the strip
}

#if os(macOS)
/// Which side panel is open on macOS (nil = none).
private enum InspectorPanel { case info, wifi }
#endif

/// The main per-device control screen: playback mode, brightness/speed sliders,
/// solid-color picker, and the pattern list (select/upload/delete). Binds to the
/// transport-agnostic `DeviceSession`, so it's identical over BLE and Wi-Fi.
/// iOS presents Info/Wi-Fi as sheets; macOS as a trailing inspector column and
/// adds Finder drag-and-drop / file-import upload (TCP only).
struct ControlView: View {
    /// The connected device's observed state + command API (see DeviceSession).
    let session: DeviceSession
    #if os(iOS)
    /// Presents the Device Info sheet (iOS).
    @State private var showInfo = false
    /// Presents the Wi-Fi provisioning sheet (iOS).
    @State private var showWifi = false
    #endif
    @State private var showImporter = false      // macOS pattern upload
    @State private var showTeardownConfirm = false   // confirm group teardown
    @State private var dropTargeted = false      // Finder drag-and-drop highlight
    #if os(macOS)
    @State private var inspectorPanel: InspectorPanel?   // open Info/Wi-Fi panel (nil = none)
    #endif
    /// The selected playback mode, mirrored to the device via `apply`. Kept as
    /// local @State (not read straight from `session.mode`) so the segmented
    /// picker stays snappy; seeded/echoed from the device in `onAppear`/`onChange`.
    @State private var playback: PlaybackMode = .play
    /// The solid-color picker's value; pushed to the device and seeded from
    /// `session.solid`. SwiftUI `Color` (resolved to RGB only when sending).
    @State private var solidColor: Color = .white
    /// Environment used to resolve `solidColor` to sRGB components without UIKit.
    @Environment(\.self) private var environment

    /// The Wi-Fi transport, when this session is over Wi-Fi (upload is TCP-only).
    private var uploader: TCPController? { session.transport as? TCPController }

    /// The scrollable control surface: Playback (mode + optional color), the
    /// Brightness and Speed sections (bump buttons + slider), the Patterns
    /// section (loading/error/empty/rows, plus macOS reload+upload header), and a
    /// trailing error section. On macOS also the Finder drag-and-drop target.
    @ViewBuilder
    private var patternList: some View {
        // A locked device (PIN set, this connection not yet authed) shows only the
        // unlock screen — there's nothing to control until it's unlocked.
        if session.needsLogin {
            LockedView(session: session)
        } else {
            unlockedList
        }
    }

    private var unlockedList: some View {
        List {
            Section("Playback") {
                // Custom bindings: the `set` closures (user interaction) send
                // commands; syncing the @State from the device seeds the controls
                // WITHOUT sending anything.
                Picker("Mode", selection: Binding(
                    get: { playback },
                    set: { newValue in playback = newValue; apply(newValue) }
                )) {
                    Text("Play").tag(PlaybackMode.play)
                    Text("Solid").tag(PlaybackMode.solid)
                    Text("Off").tag(PlaybackMode.off)
                }
                .pickerStyle(.segmented)

                if playback == .solid {
                    ColorPicker("Color", selection: Binding<Color>(
                        get: { solidColor },
                        set: { color in
                            solidColor = color
                            let (r, g, b) = rgb(from: color)
                            session.setSolid(r: r, g: g, b: b)
                        }
                    ), supportsOpacity: false)
                }
            }

            Section {
                HStack(spacing: 12) {
                    bumpButton("sun.min") { session.setBrightness(bumpedDown(session.brightness, min: 0)) }
                    Slider(
                        value: Binding(
                            get: { Double(session.brightness) },
                            set: { session.setBrightness(Int($0.rounded())) }
                        ),
                        in: 0...100
                    )
                    bumpButton("sun.max.fill") { session.setBrightness(bumpedUp(session.brightness, max: 100)) }
                }
            } header: {
                HStack {
                    Text("Brightness")
                    Spacer()
                    Text("\(session.brightness)%")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                HStack(spacing: 12) {
                    bumpButton("tortoise") { session.setSpeed(bumpedDown(session.speed, min: 10)) }
                    Slider(
                        value: Binding(
                            get: { Double(session.speed) },
                            set: { session.setSpeed(Int($0.rounded())) }
                        ),
                        in: 10...400
                    )
                    bumpButton("hare") { session.setSpeed(bumpedUp(session.speed, max: 400)) }
                }
            } header: {
                HStack {
                    Text("Speed")
                    Spacer()
                    Text("\(session.speed)%")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                if session.speed != 100 {
                    Button("Reset to 100%") { session.setSpeed(100) }
                        .font(.caption)
                }
            }

            // A leader drives the whole group's program and can end the group.
            if let role = session.role, role == "leader" || role == "leader-only" {
                Section {
                    Stepper(value: Binding(
                        get: { session.program ?? 0 },
                        set: { session.selectProgram($0) }
                    ), in: 0...255) {
                        LabeledContent("Program", value: "\(session.program ?? 0)")
                    }
                    Button(role: .destructive) { showTeardownConfirm = true } label: {
                        Label("End group", systemImage: "person.2.slash")
                    }
                    .alert("End the group?", isPresented: $showTeardownConfirm) {
                        Button("End group", role: .destructive) { session.teardown() }
                        Button("Cancel", role: .cancel) { }
                    } message: {
                        Text("The followers stop until they're started again.")
                    }
                } header: {
                    Text("Group")
                } footer: {
                    Text("Program switches the whole group to that numbered pattern (each device plays its own slice).")
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                if session.isLoadingPatterns {
                    VStack(alignment: .leading, spacing: 8) {
                        if session.listTotal > 0 {
                            ProgressView(value: Double(session.listReceived), total: Double(session.listTotal))
                            Text("Loading patterns… \(session.listReceived) of \(session.listTotal)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            HStack(spacing: 12) {
                                ProgressView()
                                Text("Loading patterns…")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                } else if session.listFailed {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                            Text("Couldn't load patterns")
                        }
                        Button("Retry") { session.refreshPatterns() }
                            .font(.callout)
                    }
                } else if session.patterns.isEmpty {
                    Text("No patterns on this device.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(session.patterns, id: \.self) { name in
                        patternRow(name)
                    }
                }
            } header: {
                HStack {
                    Text("Patterns")
                    #if os(macOS)
                    Spacer()
                    if uploader?.uploadInProgress == true {
                        ProgressView().controlSize(.mini)
                    }
                    Button { session.refreshPatterns() } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Reload patterns")
                    Button { showImporter = true } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                    .disabled(uploader == nil || uploader?.uploadInProgress == true)
                    .help(uploader == nil ? "Connect over Wi-Fi to upload a pattern" : "Upload a pattern")
                    #endif
                }
            } footer: {
                #if os(macOS)
                if let err = uploader?.uploadError {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
                #endif
            }

            if let error = session.lastError {
                Section {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .refreshable { session.refreshPatterns() }
        #if os(macOS)
        // Drag a .leda file from Finder anywhere onto the window to upload it.
        .dropDestination(for: URL.self) { urls, _ in handleDrop(urls) } isTargeted: { dropTargeted = $0 }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color.accentColor, lineWidth: 2)
                    .padding(4)
                    .allowsHitTesting(false)
            }
        }
        #endif
    }

    /// Wraps `layout` with the title, Info/Wi-Fi toolbar buttons, the iOS sheets,
    /// the control-seeding hooks, and (macOS) the file importer.
    var body: some View {
        layout
        .navigationTitle(session.connectedName)
        .inlineNavTitle()
        .toolbar {
            // While locked, the only action is to unlock — hide Info/Wi-Fi.
            if !session.needsLogin {
                #if os(macOS)
                ToolbarItem(placement: .primaryAction) {
                    Button { toggleInspector(.wifi) } label: { Image(systemName: "wifi") }
                        .help("Wi-Fi settings")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { toggleInspector(.info) } label: { Image(systemName: "info.circle") }
                        .help("Device info")
                }
                #else
                ToolbarItem(placement: .primaryAction) {
                    Button { showWifi = true } label: { Image(systemName: "wifi") }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showInfo = true } label: { Image(systemName: "info.circle") }
                }
                #endif
            }
        }
        #if os(iOS)
        .sheet(isPresented: $showInfo) {
            DeviceInfoView(session: session)
        }
        .sheet(isPresented: $showWifi) {
            WiFiView(session: session)
        }
        #endif
        // Seed the controls from what the device reports (INFO on connect, and
        // command echoes). These set @State directly, so they don't send anything.
        .onAppear {
            playback = mapMode(session.mode)
            solidColor = color(from: session.solid)
        }
        .onChange(of: session.mode) { _, m in playback = mapMode(m) }
        .onChange(of: session.solid) { _, s in solidColor = color(from: s) }
        #if os(macOS)
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [ledaType]) { result in
            if case .success(let url) = result {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) {
                    uploader?.upload(name: url.lastPathComponent, data: data)
                }
            }
        }
        #endif
    }

    // MARK: Layout

    #if os(macOS)
    /// The control list, plus a hand-built trailing inspector column when a panel
    /// is open. Rolled by hand (fixed width, explicit Divider) because SwiftUI's
    /// native .inspector mis-sized its content on first open and clipped it.
    @ViewBuilder
    private var layout: some View {
        HStack(spacing: 0) {
            patternList
            if let panel = inspectorPanel {
                Divider()
                panelView(panel)
                    .frame(width: 320)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.snappy(duration: 0.22), value: inspectorPanel)
    }

    /// Resolves an `InspectorPanel` case to its view (macOS inspector column).
    @ViewBuilder
    private func panelView(_ panel: InspectorPanel) -> some View {
        switch panel {
        case .info: DeviceInfoView(session: session)
        case .wifi: WiFiView(session: session)
        }
    }
    #else
    /// iOS layout is just the control list (Info/Wi-Fi come up as sheets).
    private var layout: some View { patternList }
    #endif

    // MARK: Patterns

    /// A pattern row. iOS: tap plays it. macOS: double-click plays it, a leading
    /// checkmark marks the loaded pattern, and a hover trash deletes it.
    @ViewBuilder
    private func patternRow(_ name: String) -> some View {
        #if os(macOS)
        MacPatternRow(
            title: displayName(name),
            isCurrent: session.currentPattern == name,
            canDelete: session.currentPattern != name,   // can't delete the loaded one
            onActivate: {
                session.select(name)
                playback = .play
            },
            onDelete: { session.delete(name) }
        )
        #else
        Button {
            session.select(name)
            playback = .play   // selecting a pattern resumes playback
        } label: {
            HStack {
                Text(displayName(name)).foregroundStyle(.primary)
                Spacer()
                if session.currentPattern == name && playback == .play {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        #endif
    }

    #if os(macOS)
    /// The `.leda` pattern file type used by the importer/drop target.
    private var ledaType: UTType { UTType(filenameExtension: "leda") ?? .data }

    /// Handle a Finder drag-and-drop: upload the first dropped .leda file.
    /// Requires a Wi-Fi (TCP) session; returns false to reject the drop otherwise.
    private func handleDrop(_ urls: [URL]) -> Bool {
        guard let uploader, !uploader.uploadInProgress else { return false }
        guard let url = urls.first(where: { $0.pathExtension.lowercased() == "leda" }) else { return false }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return false }
        uploader.upload(name: url.lastPathComponent, data: data)
        return true
    }

    /// Toggle an inspector panel: clicking its toolbar button again closes it.
    private func toggleInspector(_ panel: InspectorPanel) {
        inspectorPanel = (inspectorPanel == panel) ? nil : panel
    }
    #endif

    /// A tappable slider end-cap icon that nudges the value by a 5% step.
    private func bumpButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
    }

    /// Next 5% multiple at or below the current value (always moves down at least
    /// one step), clamped to `min`.
    private func bumpedDown(_ v: Int, min lo: Int, step: Int = 5) -> Int {
        max(lo, (v - 1) / step * step)
    }

    /// Next 5% multiple strictly above the current value, clamped to `max`.
    private func bumpedUp(_ v: Int, max hi: Int, step: Int = 5) -> Int {
        min(hi, (v / step + 1) * step)
    }

    /// Map the device's mode string (`session.mode`) to the local picker enum.
    private func mapMode(_ m: String) -> PlaybackMode {
        switch m {
        case "off": return .off
        case "solid": return .solid
        default: return .play
        }
    }

    /// Convert the device's 0–255 `RGB` into a SwiftUI `Color` for the picker.
    private func color(from rgb: RGB) -> Color {
        Color(red: Double(rgb.r) / 255, green: Double(rgb.g) / 255, blue: Double(rgb.b) / 255)
    }

    /// Send the command for a newly-selected playback mode.
    private func apply(_ mode: PlaybackMode) {
        switch mode {
        case .play:
            session.play()
        case .solid:
            let (r, g, b) = rgb(from: solidColor)
            session.setSolid(r: r, g: g, b: b)
        case .off:
            session.turnOff()
        }
    }

    /// Resolve a SwiftUI Color to 0–255 sRGB components (no UIKit dependency).
    private func rgb(from color: Color) -> (Int, Int, Int) {
        let c = color.resolve(in: environment)
        let to255 = { (v: Float) in Int((min(max(v, 0), 1) * 255).rounded()) }
        return (to255(c.red), to255(c.green), to255(c.blue))
    }

    /// Show "rainbow" rather than "rainbow.leda" in the list.
    private func displayName(_ file: String) -> String {
        file.hasSuffix(".leda") ? String(file.dropLast(5)) : file
    }
}

/// Shown in place of the controls when the device is locked (a PIN is set and
/// this connection hasn't authenticated). Persistent and self-retrying: a wrong
/// PIN leaves this on screen with an error, and the device hands back a fresh
/// challenge each time, so "Unlock" always works — no need to disconnect/reselect.
private struct LockedView: View {
    let session: DeviceSession
    @State private var pin = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Device is locked")
                .font(.headline)
            Text("Enter this device's PIN to control it.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            SecureField("PIN", text: $pin)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 200)
                .focused($focused)
                .onSubmit(submit)
            Button("Unlock", action: submit)
                .buttonStyle(.borderedProminent)
                .disabled(pin.count < 4)
            if let err = session.authError {
                Text(err)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
    }

    private func submit() {
        guard pin.count >= 4 else { return }
        session.login(pin: pin)
        pin = ""
    }
}

#if os(macOS)
/// A macOS pattern row: leading checkmark (space reserved when absent so the
/// title never shifts), double-click to play, and a trash button that appears
/// only while the row is hovered.
private struct MacPatternRow: View {
    let title: String
    let isCurrent: Bool
    let canDelete: Bool
    let onActivate: () -> Void
    let onDelete: () -> Void
    /// Whether the pointer is over the row; reveals the trash button.
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark")
                .foregroundStyle(.tint)
                .opacity(isCurrent ? 1 : 0)   // reserve the space so text doesn't jump
            Text(title)
            Spacer()
            // Always laid out (toggle opacity, not presence) so hovering never
            // changes the row's height.
            Button(action: onDelete) {
                Image(systemName: "trash")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("Delete pattern")
            .opacity(hovering && canDelete ? 1 : 0)
            .disabled(!(hovering && canDelete))
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: onActivate)
        .onHover { hovering = $0 }
    }
}
#endif
