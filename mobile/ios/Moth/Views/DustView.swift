import SwiftUI

/// NIGHT → DUST: register this account's NIGHT, choosing which account gets the DUST, or stop.
struct DustView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var receiver: DustReceiver?
    @State private var confirmingDeregister = false

    var body: some View {
        Form {
            Section {
                LabeledContent("DUST", value: model.balances.map { Amount.format($0.dust, decimals: Amount.dustDecimals, places: 6) } ?? "—")
                LabeledContent("NIGHT", value: nightHeld)
            } footer: {
                Text("Registered NIGHT generates DUST over time; DUST pays every Midnight transaction fee. Registering pays its own fee from DUST the NIGHT has already accrued, so newly received NIGHT may need to wait.")
            }
            Section("Send generated DUST to") {
                DustReceiverPicker(selection: $receiver)
            }
            Section {
                Button("Register NIGHT for DUST") { Task { await model.registerDust(to: receiver?.name == model.activeName ? nil : receiver?.dustAddress) } }
                    .disabled(model.balances?.synced != true || model.busy)
                Button("Stop generating DUST from NIGHT", role: .destructive) { confirmingDeregister = true }
                    .disabled(model.balances?.synced != true || model.busy)
            } footer: {
                Text("To move existing registrations to another account, deregister and register again.")
            }
        }
        .navigationTitle("DUST from NIGHT")
        .confirmationDialog("Stop generating DUST?", isPresented: $confirmingDeregister, titleVisibility: .visible) {
            Button("Deregister and pay fee", role: .destructive) { Task { await model.deregisterDust() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This account's NIGHT stops generating DUST. The transaction pays a DUST fee.")
        }
    }

    private var nightHeld: String {
        guard let night = model.addresses?.nightTokenId, let b = model.balances else { return "—" }
        return Amount.format(b.unshielded[night] ?? "0", decimals: Amount.nightDecimals, places: 6)
    }
}

/// Chooses which account's DUST address receives generated DUST; this account first.
struct DustReceiverPicker: View {
    @EnvironmentObject private var model: WalletModel
    @Binding var selection: DustReceiver?
    @State private var receivers: [DustReceiver] = []

    var body: some View {
        Group {
            if receivers.isEmpty {
                Text("This account").foregroundStyle(.secondary)
            } else {
                Picker("Account", selection: $selection) {
                    ForEach(receivers) { r in
                        Text(r.name == model.activeName ? "\(r.label) (this account)" : r.label).tag(Optional(r))
                    }
                }
                if let selection, selection.name != model.activeName {
                    Text(selection.dustAddress).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }
        .task(id: model.network) {
            receivers = (try? await model.dustReceivers()) ?? []
            if selection == nil || !receivers.contains(where: { $0 == selection }) { selection = receivers.first }
        }
    }
}
