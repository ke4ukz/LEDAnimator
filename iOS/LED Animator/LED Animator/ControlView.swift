//
//  ControlView.swift
//  LED Animator
//
//  Connected device: live control (playback mode, brightness, speed, solid
//  color) plus picking which pattern plays.
//

import SwiftUI

/// The three device playback states, mapped to firmware commands.
private enum PlaybackMode: Hashable {
    case play   // run the selected pattern
    case solid  // hold a solid color
    case off    // blank the strip
}

struct ControlView: View {
    let ble: BLEController
    @State private var showInfo = false
    @State private var playback: PlaybackMode = .play
    @State private var solidColor: Color = .white
    @Environment(\.self) private var environment

    var body: some View {
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
                            ble.setSolid(r: r, g: g, b: b)
                        }
                    ), supportsOpacity: false)
                }
            }

            Section {
                HStack(spacing: 12) {
                    bumpButton("sun.min") { ble.setBrightness(bumpedDown(ble.brightness, min: 0)) }
                    Slider(
                        value: Binding(
                            get: { Double(ble.brightness) },
                            set: { ble.setBrightness(Int($0.rounded())) }
                        ),
                        in: 0...100
                    )
                    bumpButton("sun.max.fill") { ble.setBrightness(bumpedUp(ble.brightness, max: 100)) }
                }
            } header: {
                HStack {
                    Text("Brightness")
                    Spacer()
                    Text("\(ble.brightness)%")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                HStack(spacing: 12) {
                    bumpButton("tortoise") { ble.setSpeed(bumpedDown(ble.speed, min: 10)) }
                    Slider(
                        value: Binding(
                            get: { Double(ble.speed) },
                            set: { ble.setSpeed(Int($0.rounded())) }
                        ),
                        in: 10...400
                    )
                    bumpButton("hare") { ble.setSpeed(bumpedUp(ble.speed, max: 400)) }
                }
            } header: {
                HStack {
                    Text("Speed")
                    Spacer()
                    Text("\(ble.speed)%")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                if ble.speed != 100 {
                    Button("Reset to 100%") { ble.setSpeed(100) }
                        .font(.caption)
                }
            }

            Section("Patterns") {
                if ble.isLoadingPatterns {
                    VStack(alignment: .leading, spacing: 8) {
                        if ble.listTotal > 0 {
                            ProgressView(value: Double(ble.listReceived), total: Double(ble.listTotal))
                            Text("Loading patterns… \(ble.listReceived) of \(ble.listTotal)")
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
                } else if ble.listFailed {
                    HStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Couldn't load patterns")
                            Text("Pull down to try again.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if ble.patterns.isEmpty {
                    Text("No patterns on this device.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(ble.patterns, id: \.self) { name in
                        Button {
                            ble.select(name)
                            playback = .play   // selecting a pattern resumes playback
                        } label: {
                            HStack {
                                Text(displayName(name))
                                    .foregroundStyle(.primary)
                                Spacer()
                                if ble.currentPattern == name && playback == .play {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let error = ble.lastError {
                Section {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .refreshable { ble.refreshPatterns() }
        .navigationTitle(ble.connectedName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
            }
        }
        .sheet(isPresented: $showInfo) {
            DeviceInfoView(ble: ble)
        }
        // Seed the controls from what the device reports (INFO on connect, and
        // command echoes). These set @State directly, so they don't send anything.
        .onAppear {
            playback = mapMode(ble.mode)
            solidColor = color(from: ble.solid)
        }
        .onChange(of: ble.mode) { _, m in playback = mapMode(m) }
        .onChange(of: ble.solid) { _, s in solidColor = color(from: s) }
    }

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

    private func mapMode(_ m: String) -> PlaybackMode {
        switch m {
        case "off": return .off
        case "solid": return .solid
        default: return .play
        }
    }

    private func color(from rgb: RGB) -> Color {
        Color(red: Double(rgb.r) / 255, green: Double(rgb.g) / 255, blue: Double(rgb.b) / 255)
    }

    /// Send the command for a newly-selected playback mode.
    private func apply(_ mode: PlaybackMode) {
        switch mode {
        case .play:
            ble.play()
        case .solid:
            let (r, g, b) = rgb(from: solidColor)
            ble.setSolid(r: r, g: g, b: b)
        case .off:
            ble.turnOff()
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
