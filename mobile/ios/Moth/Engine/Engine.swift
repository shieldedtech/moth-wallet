import Foundation
import WebKit

enum EngineError: LocalizedError {
    case serversFailed(prover: Int32, engine: Int32)
    case notLoaded
    case script(String)
    case badResult(String)

    var errorDescription: String? {
        switch self {
        case .serversFailed(let prover, let engine): "Moth could not start its local services (prover \(prover), engine \(engine))."
        case .notLoaded: "Moth's wallet engine did not load."
        case .script(let message): message
        case .badResult(let detail): "Unexpected reply from the wallet engine: \(detail)"
        }
    }
}

/// Events the engine pushes while it syncs and transacts (engine/main.ts `EngineEvent`).
enum EngineEvent {
    case balances(Balances)
    case syncMessage(String)
    case txStage(String)
    case workerError(String)
}

/// Hosts moth's wallet engine in a hidden WKWebView and calls its `window.moth` API.
/// The wallet SDK and ledger run in the page's dedicated worker, so nothing here blocks
/// the web view's main thread, let alone the app's.
@MainActor
final class Engine: NSObject {
    let webView: WKWebView
    var onEvent: (EngineEvent) -> Void = { _ in }
    private var loaded: CheckedContinuation<Void, Error>?
    private var isLoaded = false

    init(ports: NativeServers.Ports) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.addUserScript(WKUserScript(
            source: "window.MOTH_PROVER_URL='http://127.0.0.1:\(ports.prover)';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.add(WeakHandler(self), name: "moth")
        webView.navigationDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(ports.engine)/index.html")!))
    }

    func waitUntilLoaded() async throws {
        if isLoaded { return }
        try await withCheckedThrowingContinuation { loaded = $0 }
    }

    /// Calls `window.moth[function](...arguments)` and decodes its result.
    func call<T: Decodable>(_ function: String, _ arguments: [Any] = [], as: T.Type = T.self) async throws -> T {
        let value = try await invoke(function, arguments)
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: value ?? NSNull(), options: .fragmentsAllowed)
        } catch {
            throw EngineError.badResult("\(function): \(error.localizedDescription)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EngineError.badResult("\(function): \(error)")
        }
    }

    /// Calls a `window.moth` function whose result is not needed.
    func run(_ function: String, _ arguments: [Any] = []) async throws {
        _ = try await invoke(function, arguments)
    }

    private func invoke(_ function: String, _ arguments: [Any]) async throws -> Any? {
        try await waitUntilLoaded()
        do {
            return try await webView.callAsyncJavaScript(
                "return await window.moth[fn](...args)",
                arguments: ["fn": function, "args": arguments],
                contentWorld: .page)
        } catch let error as NSError {
            let message = error.userInfo["WKJavaScriptExceptionMessage"] as? String
            throw EngineError.script(message ?? error.localizedDescription)
        }
    }

    fileprivate func receive(_ body: Any) {
        guard let message = body as? [String: Any], let event = message["event"] as? String else { return }
        let data = message["data"]
        switch event {
        case "ready":
            isLoaded = true
            loaded?.resume()
            loaded = nil
        case "balances":
            if let json = try? JSONSerialization.data(withJSONObject: data ?? NSNull()),
               let balances = try? JSONDecoder().decode(Balances.self, from: json) {
                onEvent(.balances(balances))
            }
        case "syncMessage":
            onEvent(.syncMessage(data as? String ?? ""))
        case "txStage":
            onEvent(.txStage(String(describing: data ?? "")))
        case "workerError":
            onEvent(.workerError(data as? String ?? "wallet worker failed"))
        default:
            break
        }
    }
}

// Readiness comes from the page's `ready` event, not didFinish: module scripts can still be
// evaluating when the load event fires.
extension Engine: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loaded?.resume(throwing: EngineError.notLoaded)
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loaded?.resume(throwing: EngineError.notLoaded)
        loaded = nil
    }

    // iOS may kill the web content process under memory pressure; reload it. Sync resumes
    // from the persisted state, but the session is gone, so the wallet must be unlocked again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isLoaded = false
        onEvent(.workerError("Moth's wallet engine was stopped by iOS. Unlock again to continue."))
        webView.reload()
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with Engine.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var engine: Engine?
    init(_ engine: Engine) { self.engine = engine }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { engine?.receive(message.body) }
    }
}
