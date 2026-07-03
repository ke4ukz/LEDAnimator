//
//  ControlView.swift
//  LED Animator
//
//  Connected device: list its patterns and pick which one plays.
//

import SwiftUI

struct ControlView: View {
    let ble: BLEController

    var body: some View {
        List {
            Section {
                Slider(
                    value: Binding(
                        get: { Double(ble.brightness) },
                        set: { ble.setBrightness(Int($0.rounded())) }
                    ),
                    in: 0...100,
                    step: 1
                ) {
                    Text("Brightness")
                } minimumValueLabel: {
                    Image(systemName: "sun.min")
                } maximumValueLabel: {
                    Image(systemName: "sun.max.fill")
                }
            } header: {
                HStack {
                    Text("Brightness")
                    Spacer()
                    Text("\(ble.brightness)%")
                        .foregroundStyle(.secondary)
                }
            }

            if ble.patterns.isEmpty {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading patterns…")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("Patterns") {
                    ForEach(ble.patterns, id: \.self) { name in
                        Button {
                            ble.select(name)
                        } label: {
                            HStack {
                                Text(displayName(name))
                                    .foregroundStyle(.primary)
                                Spacer()
                                if ble.currentPattern == name {
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
        .navigationTitle(ble.connectedName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    ble.refreshPatterns()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
    }

    /// Show "rainbow" rather than "rainbow.bin" in the list.
    private func displayName(_ file: String) -> String {
        file.hasSuffix(".bin") ? String(file.dropLast(4)) : file
    }
}
