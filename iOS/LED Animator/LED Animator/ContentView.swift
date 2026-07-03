//
//  ContentView.swift
//  LED Animator
//

import SwiftUI

struct ContentView: View {
    @State private var ble = BLEController()

    var body: some View {
        NavigationStack {
            DeviceListView(ble: ble)
        }
    }
}

#Preview {
    ContentView()
}
