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
    var position: SIMD3<Float>
    var r: Double
    var g: Double
    var b: Double
    var trackIndex: Int = 0
    var cgColor: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) }
    var color: Color { Color(red: r, green: g, blue: b) }
}

/// A rainbow helix — visually unambiguously 3D (a common real layout: LEDs
/// spiralled around a cylinder). Placeholder until real layouts exist.
func helixLayout(count: Int, trackCount: Int = 1) -> [EditorLED] {
    (0..<count).map { i in
        let t = Float(i) / Float(max(1, count - 1))
        let angle = t * .pi * 6          // three turns
        let radius: Float = 1.3
        let (r, g, b) = hsv(Double(t), 1, 1)
        return EditorLED(
            id: i,
            position: SIMD3(cos(angle) * radius, (t - 0.5) * 3.2, sin(angle) * radius),
            r: r, g: g, b: b,
            trackIndex: min(trackCount - 1, i * trackCount / count)
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

    @State private var model = EditorModel()
    private let scene: SCNScene
    @State private var showLeft = true
    @State private var showRight = true

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    private var isCompact: Bool { hSize == .compact }
    #else
    private var isCompact: Bool { false }
    #endif

    init(title: String, onClose: @escaping () -> Void) {
        self.title = title
        self.onClose = onClose
        let m = EditorModel()
        _model = State(initialValue: m)
        self.scene = buildLEDScene(m.leds)
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            HStack(spacing: 0) {
                // Regular width: panels are pinned columns beside the viewport.
                if showLeft && !isCompact {
                    LayersPanel(model: model).frame(width: 250)
                    Divider()
                }
                VStack(spacing: 0) {
                    SceneView(scene: scene, options: [.allowsCameraControl])
                        .background(Color.black)
                    Divider()
                    timelineStrip
                }
                if showRight && !isCompact {
                    Divider()
                    InspectorPanel(model: model).frame(width: 290)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        // Compact width (iPhone): panels are drawers presented as sheets.
        .sheet(isPresented: leftSheet) {
            panelSheet("Layers") { LayersPanel(model: model) }
        }
        .sheet(isPresented: rightSheet) {
            panelSheet("Inspector") { InspectorPanel(model: model) }
        }
    }

    // Sheet bindings only fire in compact width; the toggles below drive them.
    private var leftSheet: Binding<Bool> {
        Binding(get: { showLeft && isCompact }, set: { showLeft = $0 })
    }
    private var rightSheet: Binding<Bool> {
        Binding(get: { showRight && isCompact }, set: { showRight = $0 })
    }

    private func panelSheet<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            content()
                .navigationTitle(title)
                .inlineNavTitle()
        }
        .presentationDetents([.medium, .large])
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button { onClose() } label: {
                Label("Close", systemImage: "chevron.backward")
            }
            Button { showLeft.toggle() } label: {
                Image(systemName: "sidebar.left")
            }
            .help("Toggle layers")

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

            Button { showRight.toggle() } label: {
                Image(systemName: "sidebar.right")
            }
            .help("Toggle inspector")
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
