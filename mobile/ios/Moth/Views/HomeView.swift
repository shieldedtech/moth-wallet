import CoreImage.CIFilterBuiltins
import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var sheet: Sheet?

    enum Sheet: String, Identifiable {
        case receive, send
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SyncStatus()
                }
                Section("Balances") {
                    if let b = model.balances, let night = model.addresses?.nightTokenId {
                        BalanceRow(name: "NIGHT", detail: "unshielded",
                                   amount: Amount.format(b.unshielded[night] ?? "0", decimals: Amount.nightDecimals, places: 6))
                        ForEach(b.unshielded.keys.filter { $0 != night }.sorted(), id: \.self) { id in
                            BalanceRow(name: "\(id.prefix(8))…", detail: "unshielded token", amount: b.unshielded[id] ?? "0")
                        }
                        ForEach(b.shielded.keys.sorted(), id: \.self) { id in
                            BalanceRow(name: "\(id.prefix(8))…", detail: "shielded token", amount: b.shielded[id] ?? "0")
                        }
                        BalanceRow(name: "DUST", detail: "for fees",
                                   amount: Amount.format(b.dust, decimals: Amount.dustDecimals, places: 6))
                    } else {
                        Text("Waiting for the first sync update…").foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button { sheet = .receive } label: { Label("Receive", systemImage: "arrow.down.circle") }
                    Button { sheet = .send } label: { Label("Send", systemImage: "arrow.up.circle") }
                        .disabled(model.balances?.synced != true)
                    Button { Task { await model.registerDust() } } label: { Label("Generate DUST from NIGHT", systemImage: "leaf") }
                        .disabled(model.balances?.synced != true || model.busy)
                }
            }
            .navigationTitle("Moth")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.lock() } } label: { Image(systemName: "lock") }
                        .accessibilityLabel("Lock")
                }
            }
            .sheet(item: $sheet) { sheet in
                switch sheet {
                case .receive: ReceiveView()
                case .send: SendView()
                }
            }
        }
    }
}

private struct SyncStatus: View {
    @EnvironmentObject private var model: WalletModel

    var body: some View {
        HStack(spacing: 12) {
            if model.balances?.synced == true {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.moonlime)
            } else {
                ProgressView()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(model.status.isEmpty ? "Syncing…" : model.status).font(.subheadline).lineLimit(2)
                if model.balances?.synced != true, let p = model.balances?.progress {
                    ProgressView(value: p).tint(Theme.moonlime)
                }
            }
        }
    }
}

private struct BalanceRow: View {
    let name: String
    let detail: String
    let amount: String

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(name).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(amount).font(.body.monospacedDigit())
        }
    }
}

struct ReceiveView: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind = Transfer.Kind.unshielded

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Picker("Address", selection: $kind) {
                    Text("Unshielded").tag(Transfer.Kind.unshielded)
                    Text("Shielded").tag(Transfer.Kind.shielded)
                }
                .pickerStyle(.segmented)
                if let address {
                    QRCode(text: address).frame(width: 240, height: 240)
                    Text(address).font(.caption.monospaced()).textSelection(.enabled).multilineTextAlignment(.center)
                    Button { UIPasteboard.general.string = address } label: { Label("Copy address", systemImage: "doc.on.doc") }
                        .buttonStyle(PrimaryButton())
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("Receive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private var address: String? {
        kind == .unshielded ? model.addresses?.unshielded : model.addresses?.shielded
    }
}

private struct QRCode: View {
    let text: String

    var body: some View {
        if let image {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
        }
    }

    private var image: UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct SendView: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind = Transfer.Kind.unshielded
    @State private var to = ""
    @State private var amount = ""
    @State private var fee: String?
    @State private var sentHash: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Send", selection: $kind) {
                    Text("Unshielded").tag(Transfer.Kind.unshielded)
                    Text("Shielded").tag(Transfer.Kind.shielded)
                }
                .pickerStyle(.segmented)
                Section("To") {
                    TextField(kind == .unshielded ? "mn_addr…" : "mn_shield-addr…", text: $to, axis: .vertical)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    TextField("0.0", text: $amount).keyboardType(.decimalPad)
                } header: {
                    Text(kind == .unshielded ? "Amount (NIGHT)" : "Amount (base units of \(tokenLabel))")
                } footer: {
                    if let fee { Text("Fee: \(Amount.format(fee, decimals: Amount.dustDecimals, places: 6)) DUST") }
                }
                if let sentHash {
                    Section("Submitted") { Text(sentHash).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            .navigationTitle("Send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sentHash == nil ? "Cancel" : "Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.busy ? "Working…" : fee == nil ? "Review" : "Send") { Task { await send() } }
                        .disabled(to.isEmpty || amount.isEmpty || model.busy || sentHash != nil || tokenId == nil)
                }
            }
            .onChange(of: kind) { fee = nil }
            .onChange(of: amount) { fee = nil }
            .onChange(of: to) { fee = nil }
        }
    }

    /// Unshielded sends NIGHT; shielded sends the first shielded token held (token choice
    /// comes with the token list screen).
    private var tokenId: String? {
        kind == .unshielded ? model.addresses?.nightTokenId : model.balances?.shielded.keys.sorted().first
    }

    private var tokenLabel: String { tokenId.map { "\($0.prefix(8))…" } ?? "a shielded token (none held)" }

    private func send() async {
        guard let tokenId else { return }
        do {
            let base = try await model.baseUnits(amount, tokenId: tokenId)
            let transfer = Transfer(kind: kind, tokenId: tokenId, amount: base, to: to.trimmingCharacters(in: .whitespacesAndNewlines))
            // The first tap shows the fee; the second sends.
            guard fee != nil else {
                fee = try await model.estimateFee(transfer)
                return
            }
            sentHash = try await model.send(transfer)
        } catch {
            model.error = error.localizedDescription
        }
    }
}
