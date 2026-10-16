import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the engine at moth://engine/ from the app bundle and passes moth://engine/prover/*
/// to the in-process prover, so Moth opens no network port.
final class EngineScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "moth"
    static let root = URL(string: "moth://engine/")!
    static let proverURL = "moth://engine/prover"

    private let files: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(files: URL) {
        self.files = files
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "engine" else { return fail(task, URLError(.badURL)) }
        if url.path.hasPrefix("/prover/") || url.path == "/prover" {
            forwardToProver(task, url: url)
        } else {
            serveFile(task, url: url)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.withLock { _ = stopped.insert(ObjectIdentifier(task)) }
    }

    private func serveFile(_ task: WKURLSchemeTask, url: URL) {
        let relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = files.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(files.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: file) else {
            return respond(task, url: url, status: 404, type: "text/plain", body: Data())
        }
        respond(task, url: url, status: 200, type: Self.mimeType(file.pathExtension), body: data)
    }

    private func forwardToProver(_ task: WKURLSchemeTask, url: URL) {
        var path = String(url.path.dropFirst("/prover".count))
        if path.isEmpty { path = "/" }
        if let query = url.query { path += "?" + query }
        let method = task.request.httpMethod ?? "GET"
        let body = task.request.httpBody ?? task.request.httpBodyStream.map(Self.drain) ?? Data()
        DispatchQueue.global(qos: .userInitiated).async {
            let started = Date()
            let answer = NativeProver.call(method: method, path: path, body: body)
            DebugLog.write("prover \(method) \(path) in=\(body.count)B status=\(answer.map { String($0.status) } ?? "none") "
                + "out=\(answer?.body.count ?? 0)B \(String(format: "%.2f", Date().timeIntervalSince(started)))s"
                + ((answer?.status ?? 500) >= 400 ? " body=\(String(decoding: (answer?.body ?? Data()).prefix(300), as: UTF8.self))" : ""))
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let answer else { return self.fail(task, URLError(.cannotConnectToHost)) }
                self.respond(task, url: url, status: answer.status, type: "application/octet-stream", body: answer.body)
            }
        }
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        guard !isStopped(task) else { return }
        let headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-store"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, _ error: Error) {
        guard !isStopped(task) else { return }
        task.didFailWithError(error)
    }

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        lock.withLock { stopped.remove(ObjectIdentifier(task)) != nil }
    }

    /// Reads a request body stream to its end; `hasBytesAvailable` can be false before the first read.
    private static func drain(_ stream: InputStream) -> Data {
        var data = Data()
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 256 * 1024)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    private static func mimeType(_ ext: String) -> String {
        switch ext {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript"
        case "wasm": "application/wasm"
        case "json": "application/json"
        case "gz": "application/gzip"
        default: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
