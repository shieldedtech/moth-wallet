import Foundation

/// Diagnostics in Documents/moth-debug.log, shown under Settings → Logs. Never log seeds,
/// phrases, passphrases or API keys; the lines written here are already free of them.
enum DebugLog {
    private static let queue = DispatchQueue(label: "moth.debuglog")
    private static let limit = 512 * 1024
    static let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("moth-debug.log")

    static func write(_ line: String) {
        queue.async {
            let entry = Data((ISO8601DateFormatter().string(from: Date()) + " " + line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(entry)
                try? handle.close()
            } else {
                try? entry.write(to: url)
            }
            trim()
        }
    }

    static func read() -> String {
        queue.sync { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }
    }

    static func clear() {
        queue.sync { try? FileManager.default.removeItem(at: url) }
    }

    /// Keeps the newest half once the file passes the limit.
    private static func trim() {
        guard let data = try? Data(contentsOf: url), data.count > limit else { return }
        let tail = data.suffix(limit / 2)
        let start = tail.firstIndex(of: UInt8(ascii: "\n")).map { tail.index(after: $0) } ?? tail.startIndex
        try? tail[start...].write(to: url)
    }
}
