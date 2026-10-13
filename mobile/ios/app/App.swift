import SwiftUI
import UIKit
import WebKit

// Host for moth's unmodified browser build. Two in-process servers, both bound to 127.0.0.1:
//   :6300  the Midnight proof server (vendored ledger-8.1.3, Rust)  -> moth's "server" prover mode
//   :8765  static files for the web app (fixed port = stable origin = persistent IndexedDB)
final class Host: NSObject, WKScriptMessageHandler {
    static let shared = Host()
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    var proverPort: Int32 = -1
    var webPort: Int32 = -1

    func log(_ s: String) {
        NSLog("MOTHSPIKE %@", s)
        let line = Data((ISO8601DateFormatter().string(from: Date()) + " " + s + "\n").utf8)
        let url = docs.appendingPathComponent("spike-log.txt")
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line); try? h.close() }
        else { try? line.write(to: url) }
    }

    func start() {
        let fm = FileManager.default
        let res = Bundle.main.resourceURL!
        // The proof server may download keys/SRS it lacks, so it needs a writable copy.
        let pp = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("zk-params")
        if !fm.fileExists(atPath: pp.path) {
            try! fm.copyItem(at: res.appendingPathComponent("params"), to: pp)
        }
        let t = Date()
        proverPort = mn_prover_start(pp.path, 6300, 2)
        webPort = mn_static_start(res.appendingPathComponent("web").path, 8765)
        log("servers up in \(String(format: "%.2f", Date().timeIntervalSince(t)))s: prover \(proverPort) web \(webPort)")
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [self] _ in
            log("native footprint \(Int(footprintMB())) MB, thermal \(ProcessInfo.processInfo.thermalState.rawValue)")
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        log("web \(m.body)")
    }

    func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }
}

struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let host = Host.shared
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.userContentController.add(host, name: "log")
        cfg.userContentController.addUserScript(WKUserScript(
            source: "window.MOTH_PROVER_URL='http://127.0.0.1:\(host.proverPort)';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isInspectable = true
        wv.load(URLRequest(url: URL(string: "http://127.0.0.1:\(host.webPort)/index.html")!))
        return wv
    }
    func updateUIView(_ v: WKWebView, context: Context) {}
}

@main
struct SpikeApp: App {
    init() {
        UIApplication.shared.isIdleTimerDisabled = true
        Host.shared.start()
    }
    var body: some Scene { WindowGroup { WebView().ignoresSafeArea(edges: .bottom) } }
}
