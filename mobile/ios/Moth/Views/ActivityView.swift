import SwiftUI

struct ActivityView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var items: [ActivityItem]?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if let items, items.isEmpty {
                    ContentUnavailableView("No activity yet", systemImage: "clock", description: Text("Transactions appear here once they are on chain."))
                } else if let items {
                    List(items) { ActivityRow(item: $0, night: model.addresses?.nightTokenId) }
                } else if let failure {
                    ContentUnavailableView("Activity unavailable", systemImage: "exclamationmark.triangle", description: Text(failure))
                } else {
                    ProgressView("Loading activity…")
                }
            }
            .navigationTitle("Activity")
            .refreshable { await load() }
            .task(id: model.balances?.synced) { await load() }
        }
    }

    private func load() async {
        // History is read from the synced wallet, so it waits for the first full sync.
        guard model.balances?.synced == true else { return }
        do {
            items = try await model.activity()
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

private struct ActivityRow: View {
    let item: ActivityItem
    let night: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(item.status == "SUCCESS" ? Theme.accent : .orange).frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(title).font(.headline)
                    if item.pending { Text("pending").font(.caption).foregroundStyle(.secondary) }
                    if item.status != "SUCCESS" { Text(item.status.lowercased().replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.orange) }
                }
                ForEach(Array(item.deltas.enumerated()), id: \.offset) { _, delta in
                    Text(amount(delta)).font(.subheadline.monospacedDigit())
                }
                if let fees = item.fees {
                    Text("Fee \(Amount.format(fees, decimals: Amount.dustDecimals, places: 6)) DUST").font(.caption).foregroundStyle(.secondary)
                }
                if let timestamp = item.timestamp {
                    Text(Date(timeIntervalSince1970: timestamp), style: .relative).font(.caption).foregroundStyle(.secondary)
                }
                Text(item.hash.prefix(16) + "…").font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
        }
    }

    private var title: String {
        switch item.kind {
        case "sent": "Sent"
        case "received": "Received"
        case "swap": "Swap"
        case "dust": "DUST"
        default: item.kind.capitalized
        }
    }

    private var icon: String {
        switch item.kind {
        case "sent": "arrow.up.circle"
        case "received": "arrow.down.circle"
        case "swap": "arrow.left.arrow.right.circle"
        default: "sparkles"
        }
    }

    private func amount(_ delta: ActivityItem.Delta) -> String {
        let negative = delta.amount.hasPrefix("-")
        let magnitude = negative ? String(delta.amount.dropFirst()) : delta.amount
        let sign = negative ? "−" : "+"
        if delta.tokenType == night {
            return "\(sign)\(Amount.format(magnitude, decimals: Amount.nightDecimals, places: 6)) NIGHT (\(delta.kind))"
        }
        return "\(sign)\(magnitude) \(Token.label(delta.tokenType)) (\(delta.kind))"
    }
}
