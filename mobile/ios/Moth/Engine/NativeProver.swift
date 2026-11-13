import Foundation

/// The Midnight proof server (vendored ledger-8.1.3), running in-process.
///
/// The wallet SDK's prover client accepts only http(s) URLs, so proofs go to the loopback
/// server at `url`; moth://engine/prover/ (EngineScheme) reaches the same endpoints with no socket.
enum NativeProver {
    static let port: UInt16 = 6300
    static let url = "http://127.0.0.1:\(port)"

    static func start() throws {
        let fm = FileManager.default
        // The prover downloads keys and SRS it lacks, so it needs a writable copy of the
        // bundled ones.
        let params = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("zk-params")
        if !fm.fileExists(atPath: params.path) {
            try fm.copyItem(at: Bundle.main.resourceURL!.appendingPathComponent("params"), to: params)
        }
        guard mn_inproc_start(params.path, 2) == 0, mn_prover_start(params.path, port, 2) > 0 else {
            throw EngineError.proverFailed
        }
    }

    /// One request to the prover; blocks until it answers, so call it off the main thread.
    static func call(method: String, path: String, body: Data) -> (status: Int, body: Data)? {
        var out: UnsafeMutablePointer<UInt8>?
        var length = 0
        let status = body.withUnsafeBytes { raw in
            mn_inproc_call(method, path, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, &out, &length)
        }
        guard status >= 0, let out else { return nil }
        defer { mn_free(out, length) }
        return (Int(status), Data(bytes: out, count: length))
    }
}
