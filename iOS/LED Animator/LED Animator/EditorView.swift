//
//  EditorView.swift
//  LED Animator
//
//  The native animation editor — Phase 1: the 3D LED viewport. A SceneKit scene
//  renders the LEDs as emissive spheres you can orbit/pinch/zoom, wrapped in the
//  full-window editor shell (top bar + a placeholder timeline strip). Layout is
//  a mock helix for now; selection, placement, timeline, and gradients come next.
//

import SwiftUI
import SceneKit

// MARK: - LED model + mock layout

struct EditorLED: Identifiable {
    let id: Int
    let position: SIMD3<Float>
    let r: Double
    let g: Double
    let b: Double
    var cgColor: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) }
}

/// A rainbow helix — visually unambiguously 3D (a common real layout: LEDs
/// spiralled around a cylinder). Placeholder until real layouts exist.
func helixLayout(count: Int) -> [EditorLED] {
    (0..<count).map { i in
        let t = Float(i) / Float(max(1, count - 1))
        let angle = t * .pi * 6          // three turns
        let radius: Float = 1.3
        let (r, g, b) = hsv(Double(t), 1, 1)
        return EditorLED(
            id: i,
            position: SIMD3(cos(angle) * radius, (t - 0.5) * 3.2, sin(angle) * radius),
            r: r, g: g, b: b
        )
    }
}

private func hsv(_ h: Double, _ s: Double, _ v: Double) -> (Double, Double, Double) {
    let i = floor(h * 6)
    let f = h * 6 - i
    let p = v * (1 - s)
    let q = v * (1 - f * s)
    let t = v * (1 - (1 - f) * s)
    switch Int(i) % 6 {
    case 0: return (v, t, p)
    case 1: return (q, v, p)
    case 2: return (p, v, t)
    case 3: return (p, q, v)
    case 4: return (t, p, v)
    default: return (v, p, q)
    }
}

// SCNVector3 is Float on iOS but CGFloat on macOS — bridge it in one place.
private func scnVec(_ x: Float, _ y: Float, _ z: Float) -> SCNVector3 {
    #if os(macOS)
    SCNVector3(CGFloat(x), CGFloat(y), CGFloat(z))
    #else
    SCNVector3(x, y, z)
    #endif
}

/// Build the SceneKit scene once for a set of LEDs.
func buildLEDScene(_ leds: [EditorLED]) -> SCNScene {
    let scene = SCNScene()
    scene.background.contents = CGColor(srgbRed: 0.05, green: 0.06, blue: 0.09, alpha: 1)

    for led in leds {
        let sphere = SCNSphere(radius: 0.13)
        sphere.segmentCount = 16
        let mat = SCNMaterial()
        mat.diffuse.contents = led.cgColor
        mat.emission.contents = led.cgColor   // self-lit, like a real LED
        sphere.firstMaterial = mat
        let node = SCNNode(geometry: sphere)
        node.position = scnVec(led.position.x, led.position.y, led.position.z)
        scene.rootNode.addChildNode(node)
    }

    // Gentle ambient so the unlit side of each sphere isn't pure black.
    let ambient = SCNNode()
    ambient.light = SCNLight()
    ambient.light?.type = .ambient
    ambient.light?.intensity = 250
    scene.rootNode.addChildNode(ambient)

    let camera = SCNNode()
    camera.camera = SCNCamera()
    camera.position = scnVec(0, 0, 7)
    scene.rootNode.addChildNode(camera)

    return scene
}

// MARK: - Editor shell

struct EditorView: View {
    let title: String
    let onClose: () -> Void

    private let scene: SCNScene

    init(title: String, onClose: @escaping () -> Void) {
        self.title = title
        self.onClose = onClose
        self.scene = buildLEDScene(helixLayout(count: 64))
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            SceneView(scene: scene, options: [.allowsCameraControl])
                .background(Color.black)
            Divider()
            timelineStrip
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }

    private var topBar: some View {
        HStack {
            Button { onClose() } label: {
                Label("Close", systemImage: "chevron.backward")
            }
            Spacer()
            Text(title).font(.headline).lineLimit(1)
            Spacer()
            // Placeholder tool modes (Select / Camera / Paint) — wired up later.
            Picker("Tool", selection: .constant(1)) {
                Image(systemName: "cursorarrow").tag(0)
                Image(systemName: "camera").tag(1)
                Image(systemName: "paintbrush.pointed").tag(2)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 150)
            .disabled(true)
        }
        .padding()
    }

    // The always-docked minimal timeline: transport + one track row (placeholder).
    private var timelineStrip: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "play.fill")
                Text("0:00").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                Slider(value: .constant(0.3)).disabled(true)
                Text("2.0s").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                Image(systemName: "chevron.up").foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text("Track 1").font(.caption).frame(width: 56, alignment: .leading).foregroundStyle(.secondary)
                RoundedRectangle(cornerRadius: 4)
                    .fill(LinearGradient(colors: [.red, .orange, .yellow, .green, .blue, .purple],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(height: 22)
            }
        }
        .padding(12)
        .background(.thinMaterial)
    }
}
