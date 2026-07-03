//
//  ContentView.swift
//  LED Animator
//

import SwiftUI

struct ContentView: View {
    @State private var ble = BLEController()
    @State private var wifi = TCPController()
    @State private var discovery = WiFiDiscovery()

    var body: some View {
        NavigationStack {
            DeviceListView(ble: ble, wifi: wifi, discovery: discovery)
        }
    }
}

#Preview {
    ContentView()
}
