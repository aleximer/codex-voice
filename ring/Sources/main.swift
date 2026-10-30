// Floating ring: a frameless, transparent, always-on-top VoiceRing over other windows.
// The call itself (mic, WebRTC, playback) runs in the codex-voice page, loaded in a web view behind the ring;
// the page reports its state and audio level each frame, and a click on the ring starts or ends the call.
// Click to call or hang up, drag to move, right-click for Quit.
// Usage: codex-voice-ring [url]   (default http://localhost:8765/?float)
import AppKit
import SwiftUI
import VoiceRingKit
import WebKit

let target = URL(string: CommandLine.arguments.dropFirst().first ?? "http://localhost:8765/?float")!
/// Ring diameter in points, from CODEX_VOICE_RING_SIZE (default 100). The window is larger so the glow isn't clipped.
let ringSize = CGFloat(Double(ProcessInfo.processInfo.environment["CODEX_VOICE_RING_SIZE"] ?? "") ?? 100)
/// Copies of the ring stacked on each other, from CODEX_VOICE_RING_GLOW (default 2): the ring's light is
/// partly transparent, so over a clear window one copy looks faint; each extra copy makes it more solid.
let ringLayers = max(1, Int(ProcessInfo.processInfo.environment["CODEX_VOICE_RING_GLOW"] ?? "") ?? 2)

/// A tint from a hex env var ("#rrggbb" or "rrggbb"), else the default. Tints multiply the ring's light:
/// white keeps its own colours, and the white core takes on the tint.
func tint(_ name: String, _ fallback: Color) -> Color {
    let hex = (ProcessInfo.processInfo.environment[name] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return fallback }
    return Color(red: Double(v >> 16 & 0xff) / 255, green: Double(v >> 8 & 0xff) / 255, blue: Double(v & 0xff) / 255)
}
let inCallTint = tint("CODEX_VOICE_RING_CALL_COLOR", .white)                                  // call up: the ring's own colours
let idleTint = tint("CODEX_VOICE_RING_IDLE_COLOR", Color(red: 0.35, green: 0.85, blue: 0.75)) // no call: teal
let approvalTint = tint("CODEX_VOICE_RING_APPROVAL_COLOR", Color(red: 1, green: 0.72, blue: 0.1)) // agent waits: amber

/// What the page last reported. `level` is read by the ring every frame, so it is not observed.
@Observable final class Call {
    var state: VoiceState = .idle
    /// An agent in Herdr is waiting for approval: the ring turns amber.
    var approval = false
    /// In a call with the mic muted: the ring goes grey and dim.
    var muted = false
    @ObservationIgnored var level = 0.0
}

struct RingContent: View {
    let call: Call
    let toggle: () -> Void
    var body: some View {
        var style = VoiceStyle()
        style.theme = .dark // the bright look; .auto follows the system and renders faint in light mode
        return ZStack {
            ForEach(0..<ringLayers, id: \.self) { _ in
                VoiceRing(state: call.state, source: .level { [call] in call.level }, style: style, size: ringSize)
            }
        }
            .saturation(call.muted ? 0 : 1)
            .opacity(call.muted ? 0.45 : 1)
            // Approval wins over the call state; muted (grey, above) only happens in a call.
            .colorMultiply(call.approval ? approvalTint : call.state == .idle ? idleTint : inCallTint)
            .animation(.easeInOut(duration: 0.4), value: call.approval)
            .animation(.easeInOut(duration: 0.4), value: call.state)
            .animation(.easeInOut(duration: 0.25), value: call.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Circle())
            .onTapGesture(perform: toggle)
    }
}

/// Drags move the window; plain clicks reach the ring; works without focusing the app first.
/// Takes every click in the window, even on the ring's transparent parts, so none reach the page behind it
/// (whose WebKit menu would show instead of ours).
final class RingHost: NSHostingView<RingContent> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDragged(with event: NSEvent) { window?.performDrag(with: event) }
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? (super.hitTest(point) ?? self) : nil }
    override func menu(for event: NSEvent) -> NSMenu? { menu }
}

/// The page only runs the call; it never takes clicks.
final class PassiveWebView: WKWebView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class Delegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let call = Call()
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        let size = (ringSize * 1.5).rounded()
        let screen = NSScreen.main?.visibleFrame ?? .zero
        window = NSWindow(
            contentRect: NSRect(x: screen.maxX - size - 16, y: screen.minY + 16, width: size, height: size),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "ring")
        // Stays visible (transparent, under the ring) so the page keeps its frame loop running.
        web = PassiveWebView(frame: NSRect(x: 0, y: 0, width: size, height: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = self
        web.navigationDelegate = self
        web.load(URLRequest(url: target))

        let host = RingHost(rootView: RingContent(call: call) { [weak self] in
            self?.web.evaluateJavaScript("document.getElementById('ring').click()")
        })
        host.frame = web.frame
        host.menu = NSMenu()
        host.menu?.addItem(withTitle: "Mute / unmute microphone", action: #selector(toggleMute), keyEquivalent: "").target = self
        host.menu?.addItem(withTitle: "Quit ring", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")

        let root = NSView(frame: web.frame)
        root.addSubview(web)
        root.addSubview(host)
        window.contentView = root
        window.orderFrontRegardless()
    }

    @objc func toggleMute() { web.evaluateJavaScript("toggleMute()") }

    // {mode, level, approval, muted} from the page; mode: idle | listening | muted | speaking | working.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let mode = body["mode"] as? String else { return }
        call.level = (body["level"] as? NSNumber)?.doubleValue ?? 0
        let state: VoiceState = switch mode {
        case "listening": .listening
        case "speaking": .speaking
        case "working": .processing
        default: .idle
        }
        if call.state != state { call.state = state }
        let approval = (body["approval"] as? NSNumber)?.boolValue ?? false
        if call.approval != approval { call.approval = approval }
        let muted = (body["muted"] as? NSNumber)?.boolValue ?? false
        if call.muted != muted { call.muted = muted }
    }

    // Mic for our own page only.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == target.host && origin.port == (target.port ?? 80) && type == .microphone ? .grant : .deny)
    }

    // The server may still be starting: retry instead of showing an error page.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { webView.load(URLRequest(url: target)) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon
let delegate = Delegate()
app.delegate = delegate
app.run()
