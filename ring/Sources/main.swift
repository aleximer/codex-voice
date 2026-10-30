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

/// What the page last reported. `level` is read by the ring every frame, so it is not observed.
@Observable final class Call {
    var state: VoiceState = .idle
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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Circle())
            .onTapGesture(perform: toggle)
    }
}

/// Drags move the window; plain clicks reach the ring; works without focusing the app first.
final class RingHost: NSHostingView<RingContent> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDragged(with event: NSEvent) { window?.performDrag(with: event) }
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
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: size, height: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = self
        web.navigationDelegate = self
        web.load(URLRequest(url: target))

        let host = RingHost(rootView: RingContent(call: call) { [weak self] in
            self?.web.evaluateJavaScript("document.getElementById('ring').click()")
        })
        host.frame = web.frame
        host.menu = NSMenu()
        host.menu?.addItem(withTitle: "Quit ring", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")

        let root = NSView(frame: web.frame)
        root.addSubview(web)
        root.addSubview(host)
        window.contentView = root
        window.orderFrontRegardless()
    }

    // {mode, level} from the page: idle | listening | speaking | working.
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
