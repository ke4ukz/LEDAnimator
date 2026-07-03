//
//  ContentView.swift
//  LED Animator
//

import SwiftUI

struct ContentView: View {
    @State private var ble = BLEController()
    @State private var wifi = TCPController()

    var body: some View {
        NavigationStack {
            DeviceListView(ble: ble, wifi: wifi)
        }
    }
}

#Preview {
    ContentView()
}
