//
//  LED_AnimatorApp.swift
//  LED Animator
//
//  Created by Jonathan Dean on 7/2/26.
//

import SwiftUI

/// App entry point: a single window hosting `ContentView` (given a sensible
/// default size on macOS).
@main
struct LED_AnimatorApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
        .defaultSize(width: 760, height: 520)
        #endif
    }
}
