import Foundation

/// Balances as the engine reports them: base units as decimal strings, so no amount ever
/// passes through a floating-point type.
struct Balances: Decodable, Equatable {
    struct Progress: Decodable, Equatable {
        let applied: Double
        let total: Double
    }
    struct SubProgress: Decodable, Equatable {
        let shielded: Progress
        let unshielded: Progress
        let dust: Progress
    }

    let shielded: [String: String]
    let unshielded: [String: String]
    /// SPECK.
    let dust: String
    let synced: Bool
    let subProgress: SubProgress

    /// Overall sync progress, 0...1, or nil before the totals are known.
    var progress: Double? {
        let parts = [subProgress.shielded, subProgress.unshielded, subProgress.dust]
        let total = parts.reduce(0) { $0 + $1.total }
        return total > 0 ? parts.reduce(0) { $0 + $1.applied } / total : nil
    }
}

enum Amount {
    /// NIGHT has 6 decimals (1 NIGHT = 10^6 STAR).
    static let nightDecimals = 6
    /// DUST has 15 decimals (1 DUST = 10^15 SPECK).
    static let dustDecimals = 15

    /// Formats a base-unit decimal string with `decimals` decimals, keeping `places` of them
    /// (truncated, never rounded up) and grouping the whole part.
    static func format(_ base: String, decimals: Int, places: Int) -> String {
        let digits = base.drop { $0 == "0" }
        let padded = String(repeating: "0", count: max(0, decimals + 1 - digits.count)) + digits
        let whole = padded.dropLast(decimals)
        let fraction = padded.suffix(decimals).prefix(places)
        let grouped = stride(from: whole.count, to: 0, by: -3).reversed().map { end -> String in
            let start = max(0, end - 3)
            return String(whole.dropFirst(start).prefix(end - start))
        }.joined(separator: ",")
        return places > 0 ? "\(grouped).\(fraction)" : grouped
    }
}
