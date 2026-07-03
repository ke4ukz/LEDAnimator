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
