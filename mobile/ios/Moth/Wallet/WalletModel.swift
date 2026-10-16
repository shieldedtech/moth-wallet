import Foundation
import SwiftUI

struct Addresses: Decodable, Equatable {
    let name: String
    let unshielded: String
    let shielded: String
    let dust: String
    let nightTokenId: String
}

/// A wallet in moth's keystore. Each account is its own wallet with its own recovery phrase.
struct Account: Decodable, Identifiable, Equatable {
    let name: String
    let label: String?
    let network: String
    var id: String { name }
    var title: String { label ?? (name == "main" ? "Main" : name) }
}

struct Transfer: Equatable {
    enum Kind: String { case unshielded, shielded }
    var kind: Kind
    var tokenId: String
    /// Base units, decimal string.
    var amount: String
    var to: String

    var json: [String: Any] { ["type": kind.rawValue, "tokenId": tokenId, "amount": amount, "to": to] }
}

struct ActivityItem: Decodable, Identifiable, Equatable {
    struct Delta: Decodable, Equatable {
        let tokenType: String
        let kind: String
        /// Signed base units, decimal string.
        let amount: String
    }
    let hash: String
    let kind: String
    let status: String
    /// Unix seconds.
    let timestamp: Double?
    let deltas: [Delta]
    let dustDelta: String
    let counterparty: String?
    let fees: String?
    let pending: Bool
    var id: String { hash }
}

struct CardanoStatus: Decodable, Equatable {
    let address: String
    let rewardAddress: String
    let lovelace: String
    let cnight: String
    let registered: Bool
    let registeredDustAddress: String?
    let currentCapacity: String?
    let maxCapacity: String?
    let secondsRemaining: Double?
    let midnightValid: Bool?
    let registrationCount: Int
    let legacyDustAddress: Bool
}

/// Networks Moth offers, the default for new wallets first; preview syncs fastest.
let mothNetworks = ["preview", "preprod"]

/// App state: the accounts, which one is unlocked, and what the engine reports.
@MainActor
final class WalletModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case failed(String)
        /// No wallet yet.
        case welcome
        /// A new wallet's recovery phrase, shown once for the user to write down.
        case backup(mnemonic: String)
        case locked
        case unlocked
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var activeName = UserDefaults.standard.string(forKey: "activeAccount") ?? "main"
    @Published private(set) var addresses: Addresses?
    @Published private(set) var balances: Balances?
    @Published private(set) var status = ""
    @Published var error: String?
    /// An outcome to tell the user that isn't a failure.
    @Published var notice: String?
    @Published private(set) var busy = false
    /// DApp requests waiting for the user, oldest first.
    @Published private(set) var approvals: [ApprovalRequest] = []

    private(set) var engine: Engine?
    /// Whether the locked screen asks for Face ID when it appears: at launch and after setup
    /// or switching accounts, but not after the user locks the wallet.
    private var promptOnLockedScreen = true
    /// Where a wallet being created goes once its phrase is backed up.
    private var pendingNetwork = mothNetworks[0]

    var active: Account? { accounts.first { $0.name == activeName } }
    var network: String { active?.network ?? mothNetworks[0] }

    func start() async {
        do {
            try NativeProver.start()
            let engine = Engine()
            engine.onEvent = { [weak self] in self?.handle($0) }
            self.engine = engine
            try await refreshAccounts()
            if active == nil, let first = accounts.first { setActive(first.name) }
            phase = active == nil ? .welcome : .locked
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func refreshAccounts() async throws {
        accounts = try await engine!.call("list", as: [Account].self)
    }

    private func setActive(_ name: String) {
        activeName = name
        UserDefaults.standard.set(name, forKey: "activeAccount")
    }

    /// A name no account and no Keychain key already uses, so creating never shadows an older wallet.
    private func newAccountName() -> String {
        let taken = { (name: String) in self.accounts.contains { $0.name == name } || Vault.exists(for: name) }
        if !taken("main") { return "main" }
        var n = accounts.count + 1
        while taken("account-\(n)") { n += 1 }
        return "account-\(n)"
    }

    // MARK: Accounts

    /// Creates an account with a fresh recovery phrase and shows it for backup.
    func create(network: String? = nil) async {
        await lockIfUnlocked()
        let name = newAccountName()
        let network = network ?? self.network
        await perform {
            let passphrase = try Vault.create(for: name)
            do {
                let created = try await engine!.call("create", [name, passphrase, network], as: Created.self)
                try await refreshAccounts()
                setActive(name)
                pendingNetwork = network
                phase = .backup(mnemonic: created.mnemonic)
            } catch {
                Vault.remove(for: name)
                throw error
            }
        }
    }

    /// The locked screen then asks for Face ID straight away.
    func finishBackup() {
        promptOnLockedScreen = true
        phase = .locked
    }

    func restore(phrase: String, network: String? = nil) async {
        await lockIfUnlocked()
        let words = phrase.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let name = newAccountName()
        let network = network ?? self.network
        await perform {
            let passphrase = try Vault.create(for: name)
            do {
                _ = try await engine!.call("importPhrase", [name, words, passphrase, network], as: Created.Name.self)
            } catch {
                Vault.remove(for: name)
                throw error
            }
            try await refreshAccounts()
            setActive(name)
            promptOnLockedScreen = true
            phase = .locked
        }
    }

    func switchTo(_ account: Account) async {
        guard account.name != activeName else { return }
        await lockIfUnlocked()
        setActive(account.name)
        promptOnLockedScreen = true
        phase = .locked
    }

    func rename(_ account: Account, to label: String) async {
        await perform {
            try await engine!.run("setLabel", [account.name, label, account.network])
            try await refreshAccounts()
        }
    }

    /// Removes an account from this phone. Its funds stay on chain, reachable by its phrase.
    func remove(_ account: Account) async {
        await perform {
            if account.name == activeName { await lockIfUnlocked() }
            try await engine!.run("remove", [account.name, account.network])
            Vault.remove(for: account.name)
            try await refreshAccounts()
            if account.name == activeName {
                if let next = accounts.first {
                    setActive(next.name)
                    phase = .locked
                } else {
                    phase = .welcome
                }
            }
        }
    }

    /// Moves the active account to another network; each network keeps its own sync state.
    func setNetwork(_ to: String) async {
        guard phase == .unlocked, to != network else { return }
        await perform {
            balances = nil
            status = "Switching to \(to)…"
            addresses = try await engine!.call("setNetwork", [activeName, network, to], as: Addresses.self)
            try await refreshAccounts()
            try await engine!.run("connector.setActive", [activeName, to])
            try await engine!.run("sync", [activeName, to])
        }
    }

    /// The active account's recovery phrase, after Face ID or the passcode.
    func recoveryPhrase() async throws -> String {
        let passphrase = try await Vault.passphrase(for: activeName, reason: "Show your recovery phrase")
        return try await engine!.call("exportPhrase", [activeName, passphrase, network], as: ExportedPhrase.self).value
    }

    // MARK: Security options

    /// Ask for Face ID before anything that spends or signs (option 1).
    @Published var faceIDForTransactions = UserDefaults.standard.bool(forKey: "faceIDForTransactions") {
        didSet { UserDefaults.standard.set(faceIDForTransactions, forKey: "faceIDForTransactions") }
    }

    /// Wallet keys open with Face ID only, never the device passcode (option 2).
    @Published private(set) var faceIDOnly = Vault.policy == .biometryOnly

    /// Re-protects every account's key; asks for Face ID once.
    func setFaceIDOnly(_ on: Bool) async {
        await perform {
            try await Vault.changePolicy(to: on ? .biometryOnly : .userPresence,
                                         wallets: accounts.map(\.name),
                                         reason: on ? "Require Face ID for Moth" : "Allow your passcode for Moth")
            faceIDOnly = Vault.policy == .biometryOnly
        }
        faceIDOnly = Vault.policy == .biometryOnly
    }

    /// Confirms the user is present before a transaction, when option 1 is on.
    private func authorize(_ reason: String) async throws {
        guard faceIDForTransactions else { return }
        try await Vault.confirmPresence(reason: reason)
    }

    // MARK: Auto-lock

    /// Minutes of inactivity before Moth locks; 0 means never. The extension defaults to 60.
    @Published var autoLockMinutes = UserDefaults.standard.object(forKey: "autoLockMinutes") as? Int ?? 15 {
        didSet { UserDefaults.standard.set(autoLockMinutes, forKey: "autoLockMinutes") }
    }
    private var lastActivity = Date()
    private var idleWatcher: Task<Void, Never>?

    /// Called on touches and DApp requests; an approval waiting for the user also counts as active.
    func noteActivity() {
        lastActivity = Date()
    }

    private func watchIdle() {
        idleWatcher?.cancel()
        idleWatcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.phase == .unlocked, self.autoLockMinutes > 0, self.approvals.isEmpty, !self.busy else { continue }
                if Date().timeIntervalSince(self.lastActivity) > Double(self.autoLockMinutes * 60) {
                    DebugLog.write("auto-lock after \(self.autoLockMinutes) min idle")
                    await self.lock()
                }
            }
        }
    }

    // MARK: Address book

    @Published private(set) var contacts: [Contact] = Contact.load()

    func saveContact(_ contact: Contact) {
        contacts.removeAll { $0.id == contact.id }
        contacts.append(contact)
        contacts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        Contact.save(contacts)
    }

    func deleteContact(_ contact: Contact) {
        contacts.removeAll { $0.id == contact.id }
        Contact.save(contacts)
    }

    // MARK: Lock

    /// Called by the locked screen when it appears; true at most once per prompt-worthy moment.
    func shouldPromptOnAppear() -> Bool {
        defer { promptOnLockedScreen = false }
        return promptOnLockedScreen && !busy
    }

    func unlock() async {
        await perform {
            let passphrase = try await Vault.passphrase(for: activeName, reason: "Unlock your Moth wallet")
            addresses = try await engine!.call("unlock", [activeName, passphrase, network], as: Addresses.self)
            try await engine!.run("connector.setActive", [activeName, network])
            phase = .unlocked
            noteActivity()
            watchIdle()
            status = "Starting sync…"
            try await engine!.run("sync", [activeName, network])
        }
    }

    func lock() async {
        guard phase == .unlocked else { return }
        promptOnLockedScreen = false
        await lockIfUnlocked()
        phase = .locked
    }

    private func lockIfUnlocked() async {
        guard phase == .unlocked else { return }
        try? await engine?.run("connector.setActive", [NSNull(), NSNull()])
        try? await engine?.run("lock", [activeName])
        approvals = []
        balances = nil
        addresses = nil
        cardano = nil
        cardanoProblem = nil
    }

    // MARK: Transactions

    /// Converts what the user typed to base units: NIGHT in NIGHT, other tokens as integers.
    func baseUnits(_ text: String, tokenId: String) async throws -> String {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if tokenId == addresses?.nightTokenId {
            return try await engine!.call("parseNight", [trimmed], as: String.self)
        }
        guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber) else { throw EngineError.script("Enter a whole number of base units.") }
        return trimmed
    }

    /// The DUST fee for `transfer`, in SPECK.
    /// The DUST fee for one transaction carrying all `transfers`, in SPECK.
    func estimateFee(_ transfers: [Transfer]) async throws -> String {
        busy = true
        defer { busy = false }
        return try await engine!.call("estimateFee", [activeName, network, transfers.map(\.json)], as: Fee.self).fee
    }

    /// Sends all `transfers` in one transaction.
    func send(_ transfers: [Transfer]) async throws -> String {
        try await authorize("Approve this send")
        busy = true
        defer { busy = false }
        return try await engine!.call("send", [activeName, network, transfers.map(\.json)], as: Sent.self).txHash
    }

    /// Every account's DUST address on this network, this account first.
    func dustReceivers() async throws -> [DustReceiver] {
        let all = try await engine!.call("receiverAccounts", [network], as: [DustReceiver].self)
        return all.filter { $0.name == activeName } + all.filter { $0.name != activeName && !$0.dustAddress.isEmpty }
    }

    func deregisterDust() async {
        await perform {
            try await authorize("Approve DUST deregistration")
            let hash = try await engine!.call("deregisterDust", [activeName, network], as: Sent.self).txHash
            notice = "Deregistration submitted (\(hash.prefix(12))…). This NIGHT stops generating DUST once it is on chain."
        }
    }

    /// Registers this account's NIGHT for DUST, sent to `dustAddress` or, if nil, to this account.
    func registerDust(to dustAddress: String? = nil) async {
        await perform {
            try await authorize("Approve DUST registration")
            let result = try await engine!.call("registerDust", [activeName, network, dustAddress ?? NSNull()], as: Registered.self)
            notice = Self.describe(result, nightHeld: (balances?.unshielded[addresses?.nightTokenId ?? ""] ?? "0") != "0")
        }
    }

    private static func describe(_ result: Registered, nightHeld: Bool) -> String {
        if let hash = result.txHash { return "DUST registration submitted (\(hash.prefix(12))…). DUST starts accruing once it is on chain." }
        guard let wait = result.notYet else {
            return nightHeld ? "All of this account's NIGHT is already registered for DUST." : "This account has no NIGHT to register."
        }
        let need = Amount.format(wait.feeSpecks, decimals: Amount.dustDecimals, places: 6)
        let have = Amount.format(wait.availableSpecks, decimals: Amount.dustDecimals, places: 6)
        guard let seconds = wait.secondsUntilAffordable else {
            return "Registering costs \(need) DUST, more than this NIGHT can ever generate. Hold more NIGHT and try again."
        }
        let eta = Duration.seconds(seconds).formatted(.units(allowed: [.days, .hours, .minutes], width: .wide, maximumUnitCount: 2))
        return "Registration pays its own fee from the DUST this NIGHT has generated since it arrived. "
            + "It needs \(need) DUST and has \(have) so far, about \(eta) to go. Nothing was spent; try again then."
    }

    func activity() async throws -> [ActivityItem] {
        try await engine!.call("activity", [activeName, network], as: [ActivityItem].self)
    }

    // MARK: Cardano

    static let blockfrostKey = "cardano-blockfrost-project-id"

    var blockfrostProjectId: String? { Vault.secret(Self.blockfrostKey) }

    func setBlockfrostProjectId(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { Vault.removeSecret(Self.blockfrostKey) } else { Vault.setSecret(trimmed, for: Self.blockfrostKey) }
        objectWillChange.send()
    }

    /// The Cardano network this account's Midnight network pairs with.
    var cardanoNetwork: String { network == "preview" ? "preview" : network == "mainnet" ? "mainnet" : "preprod" }

    /// The project ID for this account's Cardano network, or an error saying what is wrong with it.
    private func checkedProjectId() throws -> String {
        guard let projectId = blockfrostProjectId else { throw EngineError.script("Add a Cardano Blockfrost project ID in Settings first.") }
        // Blockfrost project IDs start with the network they serve.
        if !projectId.hasPrefix(cardanoNetwork) {
            let theirs = ["mainnet", "preprod", "preview"].first { projectId.hasPrefix($0) }
            throw EngineError.script(theirs.map { "That Blockfrost project is for Cardano \($0), but this account is on Midnight \(network), which pairs with Cardano \(cardanoNetwork). Create a Cardano \(cardanoNetwork) project at blockfrost.io." }
                ?? "That doesn't look like a Cardano Blockfrost project ID. It should start with \"\(cardanoNetwork)\". Midnight Blockfrost projects don't work here.")
        }
        return projectId
    }

    /// The latest Cardano status for the active account, while a Blockfrost project is configured.
    @Published private(set) var cardano: CardanoStatus?
    @Published private(set) var cardanoProblem: String?

    func cardanoStatus() async throws -> CardanoStatus {
        let projectId = try checkedProjectId()
        let status = try await engine!.call("cardanoStatus", [activeName, network, projectId], as: CardanoStatus.self)
        cardano = status
        cardanoProblem = nil
        return status
    }

    /// Refreshes `cardano` for the Balances list; problems are kept for display, not raised.
    func refreshCardano() async {
        guard phase == .unlocked, blockfrostProjectId != nil else {
            cardano = nil
            cardanoProblem = nil
            return
        }
        do {
            _ = try await cardanoStatus()
        } catch {
            cardano = nil
            cardanoProblem = error.localizedDescription
        }
    }

    /// This account's Cardano base address on its paired network; derived locally, no Blockfrost.
    func cardanoAddress() async throws -> String {
        try await engine!.call("cardanoAddresses", [activeName, network], as: CardanoAddress.self).address
    }

    /// Lovelace a registration locks with its auth token (moth core's LOVELACE_FOR_REGISTRATION).
    func cardanoRegistrationLovelace() async throws -> String {
        try await engine!.call("cardanoRegistrationLovelace", as: String.self)
    }

    /// Registers this account's Cardano cNIGHT to generate DUST into its Midnight DUST address.
    func cardanoRegister(_ register: Bool, receiver: String? = nil) async throws -> String {
        let projectId = try checkedProjectId()
        try await authorize(register ? "Approve Cardano registration" : "Approve Cardano deregistration")
        busy = true
        defer { busy = false }
        if register {
            return try await engine!.call("cardanoRegister", [activeName, network, projectId, receiver ?? NSNull()], as: Sent.self).txHash
        }
        return try await engine!.call("cardanoDeregister", [activeName, network, projectId], as: Sent.self).txHash
    }

    /// Points this account's existing registration at another DUST address.
    func cardanoUpdate(receiver: String) async throws -> String {
        let projectId = try checkedProjectId()
        try await authorize("Approve changing where DUST goes")
        busy = true
        defer { busy = false }
        return try await engine!.call("cardanoUpdate", [activeName, network, projectId, receiver], as: Sent.self).txHash
    }

    /// Sends ADA (lovelace) and cNIGHT (base units) on Cardano.
    func cardanoSend(to: String, lovelace: String, cnight: String) async throws -> String {
        let projectId = try checkedProjectId()
        try await authorize("Approve this Cardano send")
        busy = true
        defer { busy = false }
        return try await engine!.call("cardanoSend", [activeName, network, projectId, to, lovelace, cnight], as: Sent.self).txHash
    }

    // MARK: DApp connector

    /// Answers one DApp call; `origin` comes from the requesting frame, never from the page.
    func connectorRequest(origin: String, method: String, paramsJson: String) async -> String {
        noteActivity()
        guard let engine else { return Self.connectorFailure("Disconnected", "Moth is starting") }
        do {
            return try await engine.call("connector.request", [origin, method, paramsJson], as: String.self)
        } catch {
            return Self.connectorFailure("InternalError", error.localizedDescription)
        }
    }

    static func connectorFailure(_ code: String, _ reason: String) -> String {
        let reply: [String: Any] = ["ok": false, "error": ["code": code, "reason": reason]]
        let data = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Answers a DApp request. Approving one that spends or signs needs Face ID when option 1 is
    /// on; if the user cancels Face ID, the request stays open.
    func respond(to approval: ApprovalRequest, approved: Bool) async {
        if approved, ["balance", "transfer", "submit", "signData", "deriveAppSecret"].contains(approval.kind) {
            do {
                try await authorize("Approve \(approval.origin)'s request")
            } catch VaultError.canceled {
                return
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
        approvals.removeAll { $0.id == approval.id }
        try? await engine?.run("connector.resolve", [approval.id, approved])
    }

    func connectedSites() async throws -> [ConnectedSite] {
        try await engine!.call("connector.grants", as: [ConnectedSite].self)
    }

    func disconnect(_ origin: String) async {
        try? await engine?.run("connector.revoke", [origin])
    }

    // MARK: Plumbing

    private func perform(_ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
        } catch VaultError.canceled {
            // The user dismissed Face ID; stay where we are.
        } catch {
            DebugLog.write("error \(error.localizedDescription)")
            self.error = error.localizedDescription
        }
    }

    private func handle(_ event: EngineEvent) {
        switch event {
        case .balances(let b):
            balances = b
            if b.synced { status = "Synced" }
        case .syncMessage(let message):
            // moth prefixes progress lines with ○/●; the status line doesn't need them.
            let line = message.trimmingCharacters(in: CharacterSet(charactersIn: "○● "))
            if !line.hasPrefix("syncing") { DebugLog.write("sync \(line)") }
            status = line
        case .txStage(let stage):
            DebugLog.write("tx stage \(stage)")
            status = stage
        case .approval(let request):
            approvals.append(request)
        case .workerError(let message):
            DebugLog.write("worker \(message)")
            error = message
            approvals = []
            balances = nil
            addresses = nil
            if phase == .unlocked { phase = .locked }
        }
    }
}

/// An account DUST can be sent to (engine `receiverAccounts`).
struct DustReceiver: Decodable, Identifiable, Hashable {
    let name: String
    let label: String
    let dustAddress: String
    var id: String { name }
}

/// A saved recipient. Addresses are public, so contacts live in UserDefaults.
struct Contact: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var address: String

    var kind: String {
        if address.hasPrefix("mn_shield-addr") { return "shielded" }
        if address.hasPrefix("mn_addr") { return "unshielded" }
        if address.hasPrefix("addr") { return "Cardano" }
        return "address"
    }

    private static let key = "contacts"

    static func load() -> [Contact] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([Contact].self, from: data)) ?? []
    }

    static func save(_ contacts: [Contact]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(contacts), forKey: key)
    }
}

struct ConnectedSite: Decodable, Identifiable, Equatable {
    let origin: String
    let networkId: String
    let grantedAt: Double
    var id: String { origin }
}

private struct Created: Decodable {
    struct Name: Decodable { let name: String }
    let name: String
    let mnemonic: String
}
private struct Fee: Decodable { let fee: String }
private struct CardanoAddress: Decodable { let address: String }
private struct ExportedPhrase: Decodable { let kind: String; let value: String }
private struct Sent: Decodable { let txHash: String }
private struct Registered: Decodable {
    struct NotYet: Decodable {
        let feeSpecks: String
        let availableSpecks: String
        let secondsUntilAffordable: Double?
    }
    let txHash: String?
    let notYet: NotYet?
}
