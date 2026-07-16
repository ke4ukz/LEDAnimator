//
//  WhiteBalanceView.swift
//  LED Animator
//
//  Calibrate the strip's "canonical white": the device shows solid white and you
//  drag a point around a 2-D pad until the white on the *strip* looks right. The
//  pad is warm–cool (horizontal) × green–magenta (vertical); we don't tint the pad
//  itself, because a monitor can't honestly show what the LEDs will do — the strip
//  is the reference. Drags send WHITEBAL live (throttled); the device persists it.
//

import SwiftUI

struct WhiteBalanceView: View {
    let session: DeviceSession
    @Environment(\.dismiss) private var dismiss

    /// Knob position, each axis in [-1, 1]. x: warm(−1)…cool(+1); y: green(−1)…magenta(+1).
    @State private var knob: CGPoint = .zero
    /// Captured on open so Cancel can restore, and Done can resume the prior mode.
    @State private var originalWhite = RGB(r: 255, g: 255, b: 255)
    @State private var originalMode = "play"
    @State private var originalSolid = RGB(r: 255, g: 255, b: 255)
    @State private var started = false

    private let padSide: CGFloat = 240

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Text("Drag until the white on your strip looks right — judge it on the LEDs, not this screen. Left/right is warm/cool; up/down is green/magenta.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                labeledPad

                HStack {
                    Button("Reset to Neutral") { apply(.zero) }
                        .buttonStyle(.bordered)
                    Spacer()
                    Text(gainsLabel)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }

                Text("Calibrate at a moderate brightness — WS2812 white shifts a little with drive level.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .navigationTitle("Calibrate White")
            .inlineNavTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { cancelCal() } }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { done() } }
            }
        }
        .macSheetFrame()
        .onAppear(perform: begin)
    }

    // MARK: Pad

    /// The pad square with warm/cool/green/magenta labels around it.
    private var labeledPad: some View {
        VStack(spacing: 6) {
            axisLabel("Green")
            HStack(spacing: 8) {
                axisLabel("Warm")
                pad
                axisLabel("Cool")
            }
            axisLabel("Magenta")
        }
    }

    private func axisLabel(_ text: String) -> some View {
        Text(text).font(.caption2).foregroundStyle(.secondary)
    }

    private var pad: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.12))
            RoundedRectangle(cornerRadius: 12).strokeBorder(.secondary.opacity(0.35))
            Path { p in
                p.move(to: CGPoint(x: padSide / 2, y: 0)); p.addLine(to: CGPoint(x: padSide / 2, y: padSide))
                p.move(to: CGPoint(x: 0, y: padSide / 2)); p.addLine(to: CGPoint(x: padSide, y: padSide / 2))
            }
            .stroke(.secondary.opacity(0.18), lineWidth: 1)
            Circle()
                .fill(Color.accentColor)
                .overlay(Circle().strokeBorder(.white.opacity(0.85), lineWidth: 2))
                .frame(width: 20, height: 20)
                .position(x: (knob.x + 1) / 2 * padSide, y: (knob.y + 1) / 2 * padSide)
        }
        .frame(width: padSide, height: padSide)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0).onChanged { v in
                apply(CGPoint(x: v.location.x / padSide * 2 - 1, y: v.location.y / padSide * 2 - 1))
            }
        )
    }

    // MARK: Mapping (pad ⇄ per-channel gains)

    // White balance only *attenuates* from full white (gains ≤ 255), so the pad
    // reduces channels: cool cuts red, warm cuts blue, green cuts red+blue, magenta
    // cuts green. kX/kY are the axis strengths; floorGain keeps a channel from dying.
    private let kX: CGFloat = 110
    private let kY: CGFloat = 90
    private let floorGain: CGFloat = 60

    private func gains(for p: CGPoint) -> RGB {
        let x = p.x, y = p.y
        let dr = (x > 0 ? x * kX : 0) + (y < 0 ? -y * kY : 0)
        let db = (x < 0 ? -x * kX : 0) + (y < 0 ? -y * kY : 0)
        let dg = (y > 0 ? y * kY : 0)
        func ch(_ d: CGFloat) -> Int { Int(max(floorGain, min(255, 255 - d)).rounded()) }
        return RGB(r: ch(dr), g: ch(dg), b: ch(db))
    }

    /// Best-effort inverse, to place the knob from the device's current gains. The
    /// common red+blue cut is the green tint; the remainder is warm/cool.
    private func knobPosition(for w: RGB) -> CGPoint {
        let dr = CGFloat(255 - w.r), dg = CGFloat(255 - w.g), db = CGFloat(255 - w.b)
        let green = min(dr, db)
        let coolR = dr - green, warmB = db - green
        let x = coolR > 0 ? coolR / kX : -warmB / kX
        let y = dg > 0 ? dg / kY : -green / kY
        return CGPoint(x: max(-1, min(1, x)), y: max(-1, min(1, y)))
    }

    private var gainsLabel: String {
        let w = gains(for: knob)
        return "R \(w.r)  G \(w.g)  B \(w.b)"
    }

    // MARK: Flow

    private func begin() {
        guard !started else { return }
        started = true
        originalWhite = session.whiteBalance
        originalMode = session.mode
        originalSolid = session.solid
        knob = knobPosition(for: session.whiteBalance)
        session.requestWhiteBalance() // refresh in case we never got a snapshot
        session.setSolid(r: 255, g: 255, b: 255) // show white so the strip displays it
    }

    /// Move the knob + push the resulting gains live.
    private func apply(_ p: CGPoint) {
        knob = CGPoint(x: max(-1, min(1, p.x)), y: max(-1, min(1, p.y)))
        let w = gains(for: knob)
        session.setWhiteBalance(r: w.r, g: w.g, b: w.b)
    }

    /// Return the device to whatever it was showing before calibration.
    private func restoreMode() {
        switch originalMode {
        case "solid": session.setSolid(r: originalSolid.r, g: originalSolid.g, b: originalSolid.b)
        case "off": session.turnOff()
        default: session.play()
        }
    }

    private func done() {
        restoreMode()
        dismiss()
    }

    private func cancelCal() {
        session.setWhiteBalance(r: originalWhite.r, g: originalWhite.g, b: originalWhite.b)
        restoreMode()
        dismiss()
    }
}
