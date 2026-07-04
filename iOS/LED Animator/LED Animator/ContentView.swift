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
        HomeView(ble: ble, wifi: wifi, discovery: discovery)
        #if os(macOS)
            .frame(minWidth: 720, minHeight: 460)
        #endif
    }
}

#Preview {
    ContentView()
}
