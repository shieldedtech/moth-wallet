import SwiftUI
import WebKit

/// An in-app browser whose pages see Moth as `window.midnight.moth`.
struct BrowserView: View {
    @EnvironmentObject private var model: WalletModel
    @StateObject private var browser = DAppBrowser()
    @State private var address = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    TextField("DApp address", text: $address)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { browser.open(address) }
                    Button { browser.webView.reload() } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Reload")
                }
                .padding(8)
                if let refusal = browser.refusal {
                    Text(refusal).font(.footnote).foregroundStyle(.orange).padding(.horizontal)
                }
                DAppWebView(browser: browser)
            }
            .navigationTitle(browser.title.isEmpty ? "Browser" : browser.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button { browser.webView.goBack() } label: { Image(systemName: "chevron.backward") }
                        .disabled(!browser.canGoBack)
                    Spacer()
                    Button { browser.webView.goForward() } label: { Image(systemName: "chevron.forward") }
                        .disabled(!browser.canGoForward)
                }
            }
            .onAppear { browser.model = model }
            .onChange(of: browser.url) { address = browser.url }
        }
    }
}

@MainActor
final class DAppBrowser: NSObject, ObservableObject {
    let webView: WKWebView
    weak var model: WalletModel?
    @Published var url = ""
    @Published var title = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var refusal: String?
    private var observations: [NSKeyValueObservation] = []

    override init() {
        let config = WKWebViewConfiguration()
        // DApp storage lives apart from the engine's, which holds the encrypted keystore.
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "6D07C0DE-0000-4000-8000-00000000DA99")!)
        if let source = try? String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("engine/inject.js"), encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.accessibilityIdentifier = "dapp"
        super.init()
        config.userContentController.addScriptMessageHandler(ConnectorHandler(self), contentWorld: .page, name: "mothConnector")
        webView.navigationDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        observations = [
            webView.observe(\.url) { [weak self] web, _ in MainActor.assumeIsolated { self?.url = web.url?.absoluteString ?? "" } },
            webView.observe(\.title) { [weak self] web, _ in MainActor.assumeIsolated { self?.title = web.title ?? "" } },
            webView.observe(\.canGoBack) { [weak self] web, _ in MainActor.assumeIsolated { self?.canGoBack = web.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] web, _ in MainActor.assumeIsolated { self?.canGoForward = web.canGoForward } },
        ]
    }

    func open(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate) else { return }
        refusal = Self.refusal(for: url)
        if refusal == nil { webView.load(URLRequest(url: url)) }
    }

    /// Why a page may not talk to Moth, or nil if it may.
    static func refusal(for url: URL) -> String? {
        guard let host = url.host else { return "That address has no host." }
        let local = host == "localhost" || host == "127.0.0.1"
        if url.scheme == "https" { return nil }
        if url.scheme == "http" && local { return nil }
        return "DApps must be served over https (or http on localhost for development)."
    }

    /// The origin a connector call is attributed to, from WebKit's own record of the frame.
    static func origin(of frame: WKFrameInfo) -> String? {
        let o = frame.securityOrigin
        guard frame.isMainFrame, !o.host.isEmpty else { return nil }
        let defaultPort = (o.protocol == "https" && o.port == 443) || (o.protocol == "http" && o.port == 80)
        return o.port == 0 || defaultPort ? "\(o.protocol)://\(o.host)" : "\(o.protocol)://\(o.host):\(o.port)"
    }
}

extension DAppBrowser: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { return .allow }
        if url.scheme == "about" { return .allow }
        if let reason = Self.refusal(for: url) {
            refusal = reason
            return .cancel
        }
        refusal = nil
        return .allow
    }
}

/// Receives `window.webkit.messageHandlers.mothConnector.postMessage(...)` and replies with
/// the engine's answer. The page's own claims about its origin are never used.
private final class ConnectorHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var browser: DAppBrowser?
    init(_ browser: DAppBrowser) { self.browser = browser }

    @MainActor
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let origin = DAppBrowser.origin(of: message.frameInfo),
              let url = URL(string: origin), DAppBrowser.refusal(for: url) == nil else {
            return (WalletModel.connectorFailure("PermissionRejected", "This page cannot use Moth."), nil)
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String,
              let paramsJson = body["paramsJson"] as? String, let model = browser?.model else {
            return (WalletModel.connectorFailure("InvalidRequest", "Malformed request"), nil)
        }
        return (await model.connectorRequest(origin: origin, method: method, paramsJson: paramsJson), nil)
    }
}

private struct DAppWebView: UIViewRepresentable {
    let browser: DAppBrowser
    func makeUIView(context: Context) -> WKWebView { browser.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
