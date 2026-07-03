//
//  ControlView.swift
//  LED Animator
//
//  Connected device: brightness + pick which pattern plays.
//

import SwiftUI

struct ControlView: View {
    let ble: BLEController
    @State private var showInfo = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "sun.min")
                        .foregroundStyle(.secondary)
                    Slider(
                        value: Binding(
                            get: { Double(ble.brightness) },
                            set: { ble.setBrightness(Int($0.rounded())) }
                        ),
                        in: 0...100
                    )
                    Image(systemName: "sun.max.fill")
                        .foregroundStyle(.secondary)
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
                if ble.patterns.isEmpty {
                    if ble.isLoadingPatterns {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Loading patterns…")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text("No patterns on this device.")
                            .foregroundStyle(.secondary)
                    }
                } else {
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
            } header: {
                HStack {
                    Text("Patterns")
                    Spacer()
                    if ble.isLoadingPatterns && !ble.patterns.isEmpty {
                        ProgressView()
                            .controlSize(.small)
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
    }

    /// Show "rainbow" rather than "rainbow.leda" in the list.
    private func displayName(_ file: String) -> String {
        file.hasSuffix(".leda") ? String(file.dropLast(5)) : file
    }
}
