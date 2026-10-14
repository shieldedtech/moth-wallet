import SwiftUI

/// Registers this account's Cardano cNIGHT to generate DUST on Midnight.
struct CardanoView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var status: CardanoStatus?
    @State private var failure: String?
    @State private var submitted: String?
    @State private var confirming: Bool?
    @State private var lockedLovelace = "0"
    @State private var receiver: DustReceiver?
    @State private var confirmingUpdate = false

    var body: some View {
        Form {
            if model.blockfrostProjectId == nil {
                Section {
                    Text("Add a Cardano Blockfrost project ID in Settings to read your Cardano balance and register it.")
                }
            } else if let status {
                Section("Cardano") {
                    LabeledContent("ADA", value: Amount.format(status.lovelace, decimals: Amount.adaDecimals, places: 6))
                    LabeledContent("cNIGHT", value: Amount.format(status.cnight, decimals: Amount.nightDecimals, places: 6))
                    Text(status.address).font(.caption.monospaced()).textSelection(.enabled)
                }
                Section {
                    LabeledContent("Registered", value: status.registered ? "Yes" : "No")
                    if let valid = status.midnightValid {
                        LabeledContent("Seen by Midnight", value: valid ? "Yes" : "Rejected")
                    }
                    if let current = status.currentCapacity, let max = status.maxCapacity {
                        LabeledContent("DUST", value: "\(Amount.format(current, decimals: Amount.dustDecimals, places: 3)) of \(Amount.format(max, decimals: Amount.dustDecimals, places: 3))")
                    }
                    if let seconds = status.secondsRemaining, seconds > 0 {
                        LabeledContent("Starts in", value: Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
                    }
                    if status.registered, let target = status.registeredDustAddress, target != model.addresses?.dust {
                        Text("This registration sends DUST to a different Midnight address.").foregroundStyle(.orange)
                    }
                    if status.registrationCount > 1 || status.legacyDustAddress {
                        Text("This stake key has a registration Midnight cannot use. Deregister and register again.").foregroundStyle(.orange)
                    }
                } header: {
                    Text("DUST generation")
                } footer: {
                    Text("Registering maps this account's Cardano stake key to its Midnight DUST address, so its cNIGHT generates DUST for fees.")
                }
                Section(status.registered ? "Generated DUST goes to" : "Send generated DUST to") {
                    DustReceiverPicker(selection: $receiver)
                }
                Section {
                    if status.registered {
                        Button("Send DUST to this account instead") { confirmingUpdate = true }
                            .disabled(receiver == nil || receiver?.dustAddress == status.registeredDustAddress)
                        Button("Deregister", role: .destructive) { confirming = false }
                    } else {
                        Button("Register for DUST") { confirming = true }
                            .disabled(status.cnight == "0")
                    }
                }
                if let submitted {
                    Section("Submitted") { Text(submitted).font(.caption.monospaced()).textSelection(.enabled) }
                }
            } else if let failure {
                Section { Text(failure).foregroundStyle(.secondary) }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Cardano cNIGHT")
        .confirmationDialog(confirming == false ? "Deregister from DUST?" : "Register for DUST?",
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible) {
            Button(confirming == false ? "Deregister and pay fee" : "Register and pay fee", role: confirming == false ? .destructive : nil) {
                if let register = confirming { Task { await act(register: register) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(confirmationText)
        }
        .confirmationDialog("Change where DUST goes?", isPresented: $confirmingUpdate, titleVisibility: .visible) {
            Button("Update and pay fee") { Task { await update() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This registration's cNIGHT will generate DUST for \(receiver?.label ?? "the chosen account") instead. One Cardano transaction rewrites the registration; it pays a network fee from your ADA, and the \(Amount.format(lockedLovelace, decimals: Amount.adaDecimals, places: 6)) ADA stays locked with it.\n\nCardano \(model.cardanoNetwork) · \(model.active?.title ?? "")")
        }

        .refreshable { await load() }
        .task { await load() }
        .disabled(model.busy)
    }

    /// What the transaction does with the user's ADA and cNIGHT, stated before they sign it.
    private var confirmationText: String {
        let locked = Amount.format(lockedLovelace, decimals: Amount.adaDecimals, places: 6)
        let cardano = "Cardano \(model.cardanoNetwork) · \(model.active?.title ?? "")"
        if confirming == false {
            return "Stops this cNIGHT generating DUST.\n\n"
                + "• Returns the \(locked) ADA the registration locked, less the network fee\n"
                + "• Pays a Cardano network fee from your ADA\n\n\(cardano)"
        }
        let cnight = status.map { Amount.format($0.cnight, decimals: Amount.nightDecimals, places: 6) } ?? "your"
        let destination = receiver.map { $0.name == model.activeName ? "this account" : $0.label } ?? "this account"
        return "Lets this account's cNIGHT generate DUST for \(destination).\n\n"
            + "• Locks \(locked) ADA with the registration; deregistering returns it\n"
            + "• Pays a Cardano network fee from your ADA\n"
            + "• Passes your \(cnight) cNIGHT through the transaction; it stays in your wallet\n\n\(cardano)"
    }

    private func load() async {
        if let lovelace = try? await model.cardanoRegistrationLovelace() { lockedLovelace = lovelace }
        guard model.blockfrostProjectId != nil else { return }
        do {
            status = try await model.cardanoStatus()
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    private func update() async {
        guard let receiver else { return }
        do {
            submitted = try await model.cardanoUpdate(receiver: receiver.dustAddress)
            await load()
        } catch {
            model.error = error.localizedDescription
        }
    }

    private func act(register: Bool) async {
        do {
            let target = register && receiver?.name != model.activeName ? receiver?.dustAddress : nil
            submitted = try await model.cardanoRegister(register, receiver: target)
            await load()
        } catch {
            model.error = error.localizedDescription
        }
    }
}

/// Sends ADA and/or cNIGHT on Cardano, after a confirmation that states both amounts.
struct CardanoSendForm: View {
    @EnvironmentObject private var model: WalletModel
    let registered: Bool
    @Binding var sentHash: String?
    @State private var to = ""
    @State private var ada = ""
    @State private var cnight = ""
    @State private var confirming = false
    @State private var pickingContact = false

    var body: some View {
            Form {
                Section("To") {
                    HStack {
                        TextField("addr_test1…", text: $to, axis: .vertical)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button { pickingContact = true } label: { Image(systemName: "person.crop.circle") }
                            .accessibilityLabel("Choose a contact")
                    }
                }
                Section {
                    TextField("ADA", text: $ada).keyboardType(.decimalPad)
                    TextField("cNIGHT", text: $cnight).keyboardType(.decimalPad)
                } footer: {
                    Text(registered && !cnight.isEmpty
                         ? "This cNIGHT is registered for DUST. Sending it away reduces the DUST this account generates."
                         : "Sending cNIGHT carries the minimum ADA a Cardano output needs, even if ADA is left empty.")
                }
                if model.blockfrostProjectId == nil {
                    Section { Text("Add a Cardano Blockfrost project ID in Settings to send on Cardano.").foregroundStyle(.secondary) }
                }
                if let sentHash {
                    Section("Submitted") { Text(sentHash).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.busy ? "Sending…" : "Review") { confirming = true }
                        .disabled(to.isEmpty || (ada.isEmpty && cnight.isEmpty) || model.busy || amounts == nil
                                  || sentHash != nil || model.blockfrostProjectId == nil)
                }
            }
            .confirmationDialog("Send on Cardano?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Send and pay fee") { Task { await send() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("\(summary)\nto \(to.prefix(24))…\n\nPays a Cardano network fee from your ADA.\nCardano \(model.cardanoNetwork) · \(model.active?.title ?? "")")
            }
            .sheet(isPresented: $pickingContact) { ContactPicker(cardano: true) { to = $0.address } }
    }

    /// Lovelace and cNIGHT base units, or nil if either field isn't a valid amount.
    private var amounts: (lovelace: String, cnight: String)? {
        guard let lovelace = Self.baseUnits(ada, decimals: Amount.adaDecimals),
              let cnightUnits = Self.baseUnits(cnight, decimals: Amount.nightDecimals) else { return nil }
        return (lovelace, cnightUnits)
    }

    private var summary: String {
        [ada.isEmpty ? nil : "\(ada) ADA", cnight.isEmpty ? nil : "\(cnight) cNIGHT"].compactMap { $0 }.joined(separator: " and ")
    }

    /// "1.5" with 6 decimals → "1500000"; empty → "0"; nil for anything else.
    static func baseUnits(_ text: String, decimals: Int) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return "0" }
        let parts = t.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, parts.allSatisfy({ $0.allSatisfy(\.isNumber) }), let whole = parts.first else { return nil }
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        guard fraction.count <= decimals, !(whole.isEmpty && fraction.isEmpty) else { return nil }
        let digits = (whole.isEmpty ? "0" : String(whole)) + fraction.padding(toLength: decimals, withPad: "0", startingAt: 0)
        let trimmed = digits.drop { $0 == "0" }
        return trimmed.isEmpty ? "0" : String(trimmed)
    }

    private func send() async {
        guard let amounts else { return }
        do {
            sentHash = try await model.cardanoSend(to: to.trimmingCharacters(in: .whitespacesAndNewlines), lovelace: amounts.lovelace, cnight: amounts.cnight)
            await model.refreshCardano()
        } catch {
            model.error = error.localizedDescription
        }
    }
}
