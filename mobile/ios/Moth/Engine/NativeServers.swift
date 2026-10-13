import Foundation

/// The two in-process servers from libmoth_native, both bound to 127.0.0.1:
///   - the Midnight proof server (vendored ledger-8.1.3), which moth's `server` prover mode calls;
///   - the engine's static files, on a fixed port so the page's origin, and with it the
///     wallet's IndexedDB storage, is the same on every launch.
enum NativeServers {
    static let proverPort: UInt16 = 6300
    static let enginePort: UInt16 = 8765

    struct Ports {
        let prover: Int32
        let engine: Int32
    }

    static func start() throws -> Ports {
        let fm = FileManager.default
        let resources = Bundle.main.resourceURL!
        // The prover downloads keys and SRS it lacks, so it needs a writable copy of the
        // bundled ones.
        let params = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("zk-params")
        if !fm.fileExists(atPath: params.path) {
            try fm.copyItem(at: resources.appendingPathComponent("params"), to: params)
        }
        let prover = mn_prover_start(params.path, proverPort, 2)
        let engine = mn_static_start(resources.appendingPathComponent("engine").path, enginePort)
        guard prover > 0, engine > 0 else { throw EngineError.serversFailed(prover: prover, engine: engine) }
        return Ports(prover: prover, engine: engine)
    }
}
