//
//  PlatformModifiers.swift
//  LED Animator
//
//  Small cross-platform shims for a few SwiftUI modifiers that exist only on
//  iOS, so the shared views compile for the macOS build too.
//

import SwiftUI

enum TextAutocap { case words, never }

extension View {
    /// `navigationBarTitleDisplayMode(.inline)` on iOS; a no-op on macOS.
    @ViewBuilder
    func inlineNavTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// `textInputAutocapitalization(...)` on iOS; a no-op on macOS.
    @ViewBuilder
    func autocap(_ mode: TextAutocap) -> some View {
        #if os(iOS)
        switch mode {
        case .words: textInputAutocapitalization(.words)
        case .never: textInputAutocapitalization(.never)
        }
        #else
        self
        #endif
    }
}
