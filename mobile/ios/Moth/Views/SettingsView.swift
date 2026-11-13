import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var sites: [ConnectedSite] = []
    @State private var projectId = ""
    @State private var renaming: Account?
    @State private var newLabel = ""
    @State private var removing: Account?
    @State private var restoring = false
    @State private var showingPhrase = false
    @State private var confirmingFaceIDOnly = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Accounts") {
                    ForEach(model.accounts) { account in
                        HStack {
                            // Borderless, so tapping the row and the menu are separate targets.
                            Button { Task { await model.switchTo(account) } } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(account.title).foregroundStyle(.primary)
                                        Text(account.network).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if account.name == model.activeName { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            Menu {
                                accountActions(account)
                            } label: {
                                Image(systemName: "ellipsis.circle").imageScale(.large)
                            }
                            .accessibilityLabel("\(account.title) options")
                        }
                        .contextMenu { accountActions(account) }
                        .swipeActions {
                            Button("Remove", role: .destructive) { removing = account }
                            Button("Rename") { rename(account) }
                        }
                    }
                    Button { Task { await model.create() } } label: { Label("New account", systemImage: "plus") }
                    Button { restoring = true } label: { Label("Import a recovery phrase", systemImage: "square.and.arrow.down") }
                }

                Section {
                    Button { showingPhrase = true } label: { Label("Show recovery phrase", systemImage: "key") }
                } footer: {
                    Text("For \(model.active?.title ?? "this account"). Needs Face ID or your passcode.")
                }

                Section {
                    Toggle("Face ID for every transaction", isOn: $model.faceIDForTransactions)
                } header: {
                    Text("Security")
                } footer: {
                    Text("Asks for Face ID again before each send, DUST or Cardano transaction, and before approving a DApp request that spends or signs. Protects you if someone picks up your phone while Moth is unlocked. The cost is one extra Face ID per transaction. \(model.faceIDOnly ? "Only Face ID is accepted." : "Your passcode works if Face ID fails.")")
                }

                Section {
                    Toggle("Face ID only, no passcode", isOn: Binding(
                        get: { model.faceIDOnly },
                        set: { on in
                            if on { confirmingFaceIDOnly = true } else { Task { await model.setFaceIDOnly(false) } }
                        }))
                        .disabled(model.busy || (!model.faceIDOnly && !Vault.biometryAvailable))
                } footer: {
                    Text(Vault.biometryAvailable || model.faceIDOnly
                         ? "Moth's keys open only with your face; your phone passcode no longer unlocks Moth. Protects against someone who knows your passcode, the usual way phones are broken into. If Face ID is reset or its enrolled face changes, iOS destroys these keys for good and every account must be restored from its recovery phrase."
                         : "Set up Face ID in iOS Settings to use this.")
                }

                Section {
                    Picker("Auto-lock", selection: $model.autoLockMinutes) {
                        Text("After 1 minute").tag(1)
                        Text("After 5 minutes").tag(5)
                        Text("After 15 minutes").tag(15)
                        Text("After 1 hour").tag(60)
                        Text("Never").tag(0)
                    }
                    NavigationLink { AddressBookView() } label: { Label("Address book", systemImage: "person.2") }
                } footer: {
                    Text("Moth also locks whenever it goes to the background.")
                }

                Section {
                    Picker("Network", selection: Binding(get: { model.network }, set: { network in Task { await model.setNetwork(network) } })) {
                        ForEach(mothNetworks, id: \.self) { Text($0).tag($0) }
                    }
                } footer: {
                    Text("Moves this account to another test network. Each network keeps its own sync state, so switching back is quick.")
                }

                Section {
                    SecureField("Blockfrost project ID", text: $projectId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { model.setBlockfrostProjectId(projectId) }
                    Button("Save") { model.setBlockfrostProjectId(projectId) }
                } header: {
                    Text("Cardano")
                } footer: {
                    Text("Needed to read and register cNIGHT. Use a Cardano \(model.cardanoNetwork) project (its ID starts with \"\(model.cardanoNetwork)\"), because this account is on Midnight \(model.network).")
                }

                Section("Connected sites") {
                    if sites.isEmpty {
                        Text("No DApps are connected.").foregroundStyle(.secondary)
                    }
                    ForEach(sites) { site in
                        VStack(alignment: .leading) {
                            Text(site.origin)
                            Text(site.networkId).font(.caption).foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Disconnect", role: .destructive) {
                                Task {
                                    await model.disconnect(site.origin)
                                    await loadSites()
                                }
                            }
                        }
                    }
                }

                Section {
                    NavigationLink { LogsView() } label: { Label("Logs", systemImage: "doc.text") }
                    Button("Lock Moth") { Task { await model.lock() } }
                }
            }
            .navigationTitle("Settings")
            .task {
                projectId = model.blockfrostProjectId ?? ""
                await loadSites()
            }
            .alert("Rename account", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newLabel)
                Button("Save") { if let account = renaming { Task { await model.rename(account, to: newLabel) } } }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Remove \(removing?.title ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button("Remove from this phone", role: .destructive) { if let account = removing { Task { await model.remove(account) } } }
            } message: {
                Text("Its funds stay on chain. You need its recovery phrase to add it back.")
            }
            .sheet(isPresented: $restoring) { RestoreView() }
            .sheet(isPresented: $showingPhrase) { ShowPhraseView() }
            .confirmationDialog("Use Face ID only?", isPresented: $confirmingFaceIDOnly, titleVisibility: .visible) {
                Button("I've written down every phrase — turn on") { Task { await model.setFaceIDOnly(true) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your phone passcode will no longer open Moth.\n\nIf Face ID is reset or removed, or its enrolled face changes (including adding an alternate appearance), iOS permanently deletes the keys Moth uses, and every account on this phone must be restored from its recovery phrase. Moth cannot recover them for you.\n\nWrite down the recovery phrase of every account first (Show recovery phrase, above).")
            }
        }
    }

    @ViewBuilder private func accountActions(_ account: Account) -> some View {
        Button { rename(account) } label: { Label("Rename", systemImage: "pencil") }
        Button(role: .destructive) { removing = account } label: { Label("Remove from this phone", systemImage: "trash") }
    }

    private func rename(_ account: Account) {
        newLabel = account.title
        renaming = account
    }

    private func loadSites() async {
        sites = (try? await model.connectedSites()) ?? []
    }
}
