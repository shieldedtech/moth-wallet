import Foundation
import SwiftUI

struct Addresses: Decodable, Equatable {
    let name: String
    let unshielded: String
    let shielded: String
    let dust: String
    let nightTokenId: String
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

/// App state: which wallet exists, whether it is unlocked, and what the engine reports.
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

    // One wallet on one network for now; accounts and network switching come later.
    let network = "preprod"
    let walletName = "main"

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var addresses: Addresses?
    @Published private(set) var balances: Balances?
    @Published private(set) var status = ""
    @Published var error: String?
    @Published private(set) var busy = false

    private(set) var engine: Engine?
    /// Whether the locked screen should ask for Face ID as soon as it appears: yes at launch
    /// and after setup, no after the user locks the wallet themselves.
    private var promptOnLockedScreen = true

    func start() async {
        do {
            let ports = try NativeServers.start()
            let engine = Engine(ports: ports)
            engine.onEvent = { [weak self] in self?.handle($0) }
            self.engine = engine
            let wallets = try await engine.call("list", [network], as: [WalletSummary].self)
            phase = wallets.contains { $0.name == walletName } ? .locked : .welcome
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func create() async {
        await perform {
            let passphrase = try Vault.create(for: walletName)
            do {
                let created = try await engine!.call("create", [walletName, passphrase, network], as: Created.self)
                phase = .backup(mnemonic: created.mnemonic)
            } catch {
                Vault.remove(for: walletName)
                throw error
            }
        }
    }

    /// The locked screen then asks for Face ID straight away.
    func finishBackup() {
        promptOnLockedScreen = true
        phase = .locked
    }

    func restore(phrase: String) async {
        let words = phrase.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        await perform {
            let passphrase = try Vault.create(for: walletName)
            do {
                _ = try await engine!.call("importPhrase", [walletName, words, passphrase, network], as: WalletSummary.self)
            } catch {
                Vault.remove(for: walletName)
                throw error
            }
            phase = .locked
        }
    }

    /// Called by the locked screen when it appears; true at most once per prompt-worthy moment.
    func shouldPromptOnAppear() -> Bool {
        defer { promptOnLockedScreen = false }
        return promptOnLockedScreen && !busy
    }

    func unlock() async {
        await perform {
            let passphrase = try await Vault.passphrase(for: walletName, reason: "Unlock your Moth wallet")
            addresses = try await engine!.call("unlock", [walletName, passphrase, network], as: Addresses.self)
            phase = .unlocked
            status = "Starting sync…"
            try await engine!.run("sync", [walletName, network])
        }
    }

    func lock() async {
        guard phase == .unlocked else { return }
        promptOnLockedScreen = false
        try? await engine?.run("lock", [walletName])
        balances = nil
        addresses = nil
        phase = .locked
    }

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
    func estimateFee(_ transfer: Transfer) async throws -> String {
        try await engine!.call("estimateFee", [walletName, network, [transfer.json]], as: Fee.self).fee
    }

    func send(_ transfer: Transfer) async throws -> String {
        busy = true
        defer { busy = false }
        return try await engine!.call("send", [walletName, network, [transfer.json]], as: Sent.self).txHash
    }

    func registerDust() async {
        await perform {
            let result = try await engine!.call("registerDust", [walletName, network], as: Registered.self)
            status = result.txHash.map { "DUST registration submitted: \($0.prefix(12))…" } ?? "All NIGHT is already generating DUST."
        }
    }

    private func perform(_ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
        } catch VaultError.canceled {
            // The user dismissed Face ID; stay where we are.
        } catch {
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
            status = message.trimmingCharacters(in: CharacterSet(charactersIn: "○● "))
        case .txStage(let stage):
            status = stage
        case .workerError(let message):
            error = message
            balances = nil
            addresses = nil
            if phase == .unlocked { phase = .locked }
        }
    }
}

private struct WalletSummary: Decodable { let name: String }
private struct Created: Decodable { let name: String; let mnemonic: String }
private struct Fee: Decodable { let fee: String }
private struct Sent: Decodable { let txHash: String }
private struct Registered: Decodable { let txHash: String? }
