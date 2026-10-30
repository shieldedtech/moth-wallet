import SwiftUI

/// Asks the user about one DApp request, showing what it would do with their wallet.
struct ApprovalView: View {
    @EnvironmentObject private var model: WalletModel
    let request: ApprovalRequest

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Site", value: request.origin)
                    LabeledContent("Account", value: model.active?.title ?? "")
                    LabeledContent("Network", value: model.network)
                }
                details
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Reject", role: .cancel) { Task { await model.respond(to: request, approved: false) } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(approveLabel) { Task { await model.respond(to: request, approved: true) } }
                }
            }
        }
    }

    private var title: String {
        switch request.kind {
        case "connect": "Connect"
        case "signData": "Sign message"
        case "deriveAppSecret": "App secret"
        case "balance": "Approve transaction"
        case "transfer": "Approve transfer"
        case "submit": "Submit transaction"
        default: "Request"
        }
    }

    private var approveLabel: String {
        switch request.kind {
        case "connect": "Connect"
        case "signData": "Sign"
        case "submit": "Submit"
        default: "Approve"
        }
    }

    @ViewBuilder private var details: some View {
        let p = request.payload
        switch request.kind {
        case "connect":
            Section {
                Label("See your addresses and balances", systemImage: "eye")
                Label("Ask you to approve transactions and signatures", systemImage: "signature")
                Label("Never move funds without your approval", systemImage: "hand.raised")
            } header: {
                Text("This site will be able to")
            }
        case "signData":
            Section("Message (\(p["encoding"] as? String ?? ""))") {
                Text(p["message"] as? String ?? "").font(.body.monospaced()).textSelection(.enabled)
            }
            Section { Text("Only sign messages from sites you trust. A signature can prove you control this account.").font(.footnote) }
        case "deriveAppSecret":
            Section("Domain") { Text(p["domain"] as? String ?? "").font(.body.monospaced()) }
            Section { Text("Gives this site a secret unique to it and to this account. Other sites cannot derive it.").font(.footnote) }
        case "balance":
            if let summary = p["summary"] as? [String: Any] {
                amounts("You pay", summary["spends"])
                amounts("You get back", summary["receives"])
                if let calls = summary["contractActions"] as? Int, calls > 0 {
                    Section { LabeledContent("Contract actions", value: "\(calls)") }
                }
            } else {
                Section { Text("Moth could not read this transaction, so the amounts are unknown.").foregroundStyle(.orange) }
            }
            fees(p)
        case "transfer":
            if let inputs = p["inputs"] as? [[String: Any]], !inputs.isEmpty {
                Section("You give") { ForEach(Array(inputs.enumerated()), id: \.offset) { row($0.element) } }
            }
            Section("You send") {
                ForEach(Array(((p["outputs"] as? [[String: Any]]) ?? []).enumerated()), id: \.offset) { item in
                    VStack(alignment: .leading) {
                        row(item.element)
                        Text(item.element["recipient"] as? String ?? "").font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
            fees(p)
        case "submit":
            Section { Text("Sends a \(p["bytes"] as? Int ?? 0)-byte transaction this site prepared to the network. This cannot be undone.") }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private func amounts(_ title: String, _ entries: Any?) -> some View {
        if let rows = entries as? [[String: Any]], !rows.isEmpty {
            Section(title) {
                ForEach(Array(rows.enumerated()), id: \.offset) { item in
                    let entry = item.element
                    LabeledContent(tokenName(entry["tokenType"] as? String, kind: entry["kind"] as? String),
                                   value: formatted(entry["amount"] as? String ?? "0", token: entry["tokenType"] as? String, kind: entry["kind"] as? String))
                }
            }
        }
    }

    private func row(_ entry: [String: Any]) -> some View {
        LabeledContent("\(tokenName(entry["type"] as? String, kind: nil)) (\(entry["kind"] as? String ?? ""))",
                       value: formatted(entry["value"] as? String ?? "0", token: entry["type"] as? String, kind: nil))
    }

    @ViewBuilder private func fees(_ p: [String: Any]) -> some View {
        Section { LabeledContent("Network fee", value: (p["payFees"] as? Bool ?? true) ? "Paid in DUST by this account" : "Not paid by this account") }
    }

    private func tokenName(_ token: String?, kind: String?) -> String {
        if kind == "dust" { return "DUST" }
        guard let token else { return "?" }
        return token == model.addresses?.nightTokenId ? "NIGHT" : Token.label(token)
    }

    private func formatted(_ amount: String, token: String?, kind: String?) -> String {
        if kind == "dust" { return Amount.format(amount, decimals: Amount.dustDecimals, places: 6) }
        if token == model.addresses?.nightTokenId { return Amount.format(amount, decimals: Amount.nightDecimals, places: 6) }
        return amount
    }
}
