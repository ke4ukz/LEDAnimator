//
//  EditorPanels.swift
//  LED Animator
//
//  The editor's side panels — a left "Layers" panel (Tracks / LEDs) and a right
//  contextual "Inspector" (track editor with gradient, LED editor, or the
//  display + arrangement settings when nothing is selected). Mirrors the web
//  app's feature set. Controls are wired to a mock EditorModel for now; hooking
//  them to the real project + 3D scene comes next.
//

import SwiftUI

// MARK: - Model

enum LEDShape: String, CaseIterable, Identifiable { case sphere, cube; var id: String { rawValue } }
enum TrackPath: String, CaseIterable, Identifiable {
    case linear = "Linear", radial = "Radial", conic = "Conic", sine = "Sine", ring = "Ring"
    var id: String { rawValue }
}

struct EditorTrack: Identifiable, Hashable {
    let id: Int
    var name: String
    var tint: Color
    var path: TrackPath = .linear
    var speed: Double = 1
    var offset: Double = 0
    var chase: Bool = false
    var gradient: [Color]
}

enum EditorSelection: Equatable { case none, track(Int), led(Int) }

@Observable
final class EditorModel {
    var leds: [EditorLED]
    var tracks: [EditorTrack]
    var selection: EditorSelection = .none

    // Display settings (view options).
    var ledScale: Double = 1
    var ledShape: LEDShape = .sphere
    var showLabels = false

    init() {
        tracks = [
            EditorTrack(id: 0, name: "Base", tint: .blue, gradient: [.red, .orange, .yellow, .green, .blue, .purple]),
            EditorTrack(id: 1, name: "Accent", tint: .pink, gradient: [.white, .cyan]),
        ]
        leds = helixLayout(count: 64, trackCount: 2)
    }

    func ledCount(inTrack id: Int) -> Int { leds.filter { $0.trackIndex == id }.count }

    func addTrack() {
        let id = (tracks.map(\.id).max() ?? -1) + 1
        tracks.append(EditorTrack(id: id, name: "Track \(id + 1)", tint: .gray, gradient: [.white, .black]))
        selection = .track(id)
    }

    func deleteTrack(_ id: Int) {
        guard tracks.count > 1 else { return }
        tracks.removeAll { $0.id == id }
        // Reassign orphaned LEDs to the first remaining track.
        let fallback = tracks.first!.id
        for i in leds.indices where leds[i].trackIndex == id { leds[i].trackIndex = fallback }
        if selection == .track(id) { selection = .none }
    }

    func trackIndex(_ id: Int) -> Int? { tracks.firstIndex { $0.id == id } }
    func ledIndex(_ id: Int) -> Int? { leds.firstIndex { $0.id == id } }
}

// MARK: - Left: Layers panel (Tracks / LEDs)

struct LayersPanel: View {
    @Bindable var model: EditorModel
    @State private var tab = 0   // 0 = Tracks, 1 = LEDs

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text("Tracks").tag(0)
                Text("LEDs").tag(1)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            Divider()
            if tab == 0 { tracksList } else { ledsList }
        }
        .frame(maxHeight: .infinity)
        .background(.background)
    }

    private var tracksList: some View {
        List {
            ForEach(model.tracks) { t in
                HStack(spacing: 8) {
                    Circle().fill(t.tint).frame(width: 10, height: 10)
                    Text(t.name)
                    Spacer()
                    Text("\(model.ledCount(inTrack: t.id))").font(.caption).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
                .onTapGesture { model.selection = .track(t.id) }
                .listRowBackground(isSelected(.track(t.id)) ? Color.accentColor.opacity(0.18) : nil)
                .contextMenu {
                    Button(role: .destructive) { model.deleteTrack(t.id) } label: {
                        Label("Delete Track", systemImage: "trash")
                    }
                    .disabled(model.tracks.count <= 1)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { model.addTrack() } label: {
                Label("Add Track", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .padding(8)
        }
    }

    private var ledsList: some View {
        List {
            ForEach(model.leds) { led in
                HStack(spacing: 8) {
                    Text("\(led.id)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(width: 26, alignment: .trailing)
                    RoundedRectangle(cornerRadius: 3).fill(led.color).frame(width: 16, height: 16)
                        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.white.opacity(0.15)))
                    Text(trackName(led.trackIndex)).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                .contentShape(Rectangle())
                .onTapGesture { model.selection = .led(led.id) }
                .listRowBackground(isSelected(.led(led.id)) ? Color.accentColor.opacity(0.18) : nil)
            }
        }
    }

    private func isSelected(_ s: EditorSelection) -> Bool { model.selection == s }
    private func trackName(_ idx: Int) -> String { model.tracks.first { $0.id == idx }?.name ?? "—" }
}

// MARK: - Right: contextual Inspector

struct InspectorPanel: View {
    @Bindable var model: EditorModel

    var body: some View {
        Group {
            switch model.selection {
            case .track(let id): trackEditor(id)
            case .led(let id): ledEditor(id)
            case .none: settings
            }
        }
        .frame(maxHeight: .infinity)
        .background(.background)
    }

    // MARK: Track editor

    @ViewBuilder
    private func trackEditor(_ id: Int) -> some View {
        if let idx = model.trackIndex(id) {
            Form {
                Section("Track") {
                    TextField("Name", text: $model.tracks[idx].name)
                    Picker("Path", selection: $model.tracks[idx].path) {
                        ForEach(TrackPath.allCases) { Text($0.rawValue).tag($0) }
                    }
                    slider("Speed", value: $model.tracks[idx].speed, in: 0.1...4, unit: "×")
                    slider("Offset", value: $model.tracks[idx].offset, in: 0...1)
                    Toggle("Chase", isOn: $model.tracks[idx].chase)
                }
                Section("Gradient") {
                    LinearGradient(colors: model.tracks[idx].gradient, startPoint: .leading, endPoint: .trailing)
                        .frame(height: 26)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .listRowInsets(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
                    ForEach(model.tracks[idx].gradient.indices, id: \.self) { s in
                        ColorPicker("Stop \(s + 1)", selection: $model.tracks[idx].gradient[s], supportsOpacity: false)
                    }
                    HStack {
                        Button { model.tracks[idx].gradient.append(.white) } label: { Label("Add Stop", systemImage: "plus") }
                        Spacer()
                        Button(role: .destructive) {
                            if model.tracks[idx].gradient.count > 2 { model.tracks[idx].gradient.removeLast() }
                        } label: { Label("Remove", systemImage: "minus") }
                            .disabled(model.tracks[idx].gradient.count <= 2)
                    }
                    .font(.callout)
                }
            }
            .formStyle(.grouped)
        }
    }

    // MARK: LED editor

    @ViewBuilder
    private func ledEditor(_ id: Int) -> some View {
        if let idx = model.ledIndex(id) {
            Form {
                Section("LED \(id)") {
                    axisRow("X", value: Binding(get: { Double(model.leds[idx].position.x) },
                                                set: { model.leds[idx].position.x = Float($0) }))
                    axisRow("Y", value: Binding(get: { Double(model.leds[idx].position.y) },
                                                set: { model.leds[idx].position.y = Float($0) }))
                    axisRow("Z", value: Binding(get: { Double(model.leds[idx].position.z) },
                                                set: { model.leds[idx].position.z = Float($0) }))
                }
                Section("Assignment") {
                    Picker("Track", selection: Binding(
                        get: { model.leds[idx].trackIndex },
                        set: { model.leds[idx].trackIndex = $0 }
                    )) {
                        ForEach(model.tracks) { Text($0.name).tag($0.id) }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    // MARK: Default — display + arrangement

    private var settings: some View {
        Form {
            Section("Display") {
                slider("LED size", value: $model.ledScale, in: 0.2...3, unit: "×")
                Picker("Shape", selection: $model.ledShape) {
                    ForEach(LEDShape.allCases) { Text($0.rawValue.capitalized).tag($0) }
                }
                Toggle("Show numbers", isOn: $model.showLabels)
            }
            Section("Arrangement") {
                LabeledContent("Shape", value: "Helix")
                Text("Generate LED positions from a shape preset. (Coming soon.)")
                    .font(.caption).foregroundStyle(.secondary)
                Button { } label: { Label("Add Shape…", systemImage: "plus") }
                    .disabled(true)
            }
            Section {
                Text("Select a track or an LED to edit it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: Small controls

    private func slider(_ label: String, value: Binding<Double>, in range: ClosedRange<Double>, unit: String = "") -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label)
                Spacer()
                Text(String(format: unit == "×" ? "%.1f%@" : "%.2f%@", value.wrappedValue, unit))
                    .foregroundStyle(.secondary).monospacedDigit()
            }
            Slider(value: value, in: range)
        }
    }

    private func axisRow(_ label: String, value: Binding<Double>) -> some View {
        HStack {
            Text(label).frame(width: 16, alignment: .leading)
            Slider(value: value, in: -3...3)
            Text(String(format: "%.2f", value.wrappedValue))
                .foregroundStyle(.secondary).monospacedDigit().frame(width: 44, alignment: .trailing)
        }
    }
}
