import Foundation
import LocalAuthentication
import Security

enum VaultError: LocalizedError {
    case canceled
    case notFound
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .canceled: "Unlock was canceled."
        case .notFound: "This wallet's key is missing from the Keychain. Restore it from its recovery phrase."
        case .keychain(let status): "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
        }
    }
}

/// Holds each wallet's keystore passphrase in the Keychain, behind Face ID or the device
/// passcode.
///
/// The passphrase is 32 random bytes the user never sees. Moth's keystore encrypts the
/// recovery phrase with it (scrypt + AES-GCM, in the engine's IndexedDB), so the phrase is
/// only readable after the device has authenticated the user. The item never leaves this
/// device (no iCloud Keychain sync, no backups); the recovery phrase is the backup.
enum Vault {
    private static let service = "io.shielded.moth.keystore"

    /// Creates and stores a fresh passphrase for `wallet`, replacing any previous one.
    static func create(for wallet: String) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
        let passphrase = bytes.map { String(format: "%02x", $0) }.joined()

        // Never replace a key: an existing one may be the only way into an older keystore.
        guard !exists(for: wallet) else { throw VaultError.keychain(errSecDuplicateItem) }
        try store(passphrase, for: wallet, policy: policy)
        return passphrase
    }

    // MARK: Protection policy

    /// How the Keychain guards each wallet's key.
    enum Policy: String {
        /// Face ID, falling back to the device passcode. Re-enrolling a face keeps the key.
        case userPresence
        /// Face ID only. Re-enrolling or resetting Face ID destroys the key for good.
        case biometryOnly

        var flags: SecAccessControlCreateFlags { self == .userPresence ? .userPresence : .biometryCurrentSet }
        var laPolicy: LAPolicy { self == .userPresence ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics }
    }

    static var policy: Policy {
        get { UserDefaults.standard.string(forKey: "vaultPolicy").flatMap(Policy.init) ?? .userPresence }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "vaultPolicy") }
    }

    /// Whether Face ID (or Touch ID) is enrolled, so a biometry-only key could be opened.
    static var biometryAvailable: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    private static func store(_ passphrase: String, for wallet: String, policy: Policy) throws {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, policy.flags, &error) else {
            throw VaultError.keychain(errSecParam)
        }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
            kSecAttrAccessControl as String: access,
            kSecValueData as String: Data(passphrase.utf8),
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw VaultError.keychain(added) }
    }

    /// Asks for Face ID (or, under `.userPresence`, the passcode as a fallback) without reading a key.
    static func confirmPresence(reason: String) async throws {
        let context = LAContext()
        do {
            _ = try await context.evaluatePolicy(policy.laPolicy, localizedReason: reason)
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            throw VaultError.canceled
        }
    }

    /// Re-saves every wallet's key under `newPolicy`, after one Face ID check.
    ///
    /// Each key is read first and held in memory; if re-saving one fails, it is put back
    /// under the old policy before the error is reported, so no key is ever left missing.
    static func changePolicy(to newPolicy: Policy, wallets: [String], reason: String) async throws {
        let oldPolicy = policy
        guard newPolicy != oldPolicy else { return }
        let context = LAContext()
        do {
            _ = try await context.evaluatePolicy(oldPolicy.laPolicy, localizedReason: reason)
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            throw VaultError.canceled
        }
        var keys: [(String, String)] = []
        for wallet in wallets where exists(for: wallet) {
            keys.append((wallet, try read(wallet, context: context)))
        }
        for (wallet, passphrase) in keys {
            // A copy under the new policy exists before the original is touched, so even a crash
            // between the delete and the add leaves the key in the Keychain.
            let spare = wallet + ".rewrap"
            remove(for: spare)
            try store(passphrase, for: spare, policy: newPolicy)
            remove(for: wallet)
            do {
                try store(passphrase, for: wallet, policy: newPolicy)
            } catch {
                try? store(passphrase, for: wallet, policy: oldPolicy)
                DebugLog.write("vault: re-saving \(wallet) failed; spare copy kept: \(error.localizedDescription)")
                throw error
            }
            remove(for: spare)
        }
        policy = newPolicy
        DebugLog.write("vault: \(keys.count) key(s) now \(newPolicy.rawValue)")
    }

    private static func read(_ wallet: String, context: LAContext) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let passphrase = String(data: data, encoding: .utf8) else {
            throw VaultError.keychain(status == errSecSuccess ? errSecDecode : status)
        }
        return passphrase
    }

    /// Reads `wallet`'s passphrase, prompting for Face ID or the passcode.
    static func passphrase(for wallet: String, reason: String) async throws -> String {
        do {
            return try await readPrompting(wallet, reason: reason)
        } catch VaultError.notFound where exists(for: wallet + ".rewrap") {
            // A protection change was interrupted after the original was removed.
            DebugLog.write("vault: \(wallet) missing, using its spare copy")
            return try await readPrompting(wallet + ".rewrap", reason: reason)
        }
    }

    private static func readPrompting(_ wallet: String, reason: String) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            context.localizedReason = reason
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: wallet,
                kSecReturnData as String: true,
                kSecUseAuthenticationContext as String: context,
            ]
            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                guard let data = result as? Data, let passphrase = String(data: data, encoding: .utf8) else {
                    throw VaultError.keychain(errSecDecode)
                }
                return passphrase
            case errSecUserCanceled: throw VaultError.canceled
            case errSecItemNotFound: throw VaultError.notFound
            default: throw VaultError.keychain(status)
            }
        }.value
    }

    /// Whether a key exists for `wallet`, checked without prompting for Face ID.
    static func exists(for wallet: String) -> Bool {
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
            kSecUseAuthenticationContext as String: context,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    static func remove(for wallet: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

extension Vault {
    private static let secretService = "io.shielded.moth.settings"

    /// Stores a non-wallet secret, such as an API key, readable without Face ID.
    static func setSecret(_ value: String, for key: String) {
        removeSecret(key)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: secretService,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(value.utf8),
        ]
        SecItemAdd(add as CFDictionary, nil)
    }

    static func secret(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: secretService,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func removeSecret(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: secretService,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
