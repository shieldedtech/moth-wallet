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

        var error: Unmanaged<CFError>?
        // .userPresence: Face ID / Touch ID, falling back to the device passcode. Unlike
        // .biometryCurrentSet, re-enrolling a face does not destroy the wallet's key.
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error
        ) else {
            throw VaultError.keychain(errSecParam)
        }
        remove(for: wallet)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
            kSecAttrAccessControl as String: access,
            kSecValueData as String: Data(passphrase.utf8),
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw VaultError.keychain(added) }
        return passphrase
    }

    /// Reads `wallet`'s passphrase, prompting for Face ID or the passcode.
    static func passphrase(for wallet: String, reason: String) async throws -> String {
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

    static func remove(for wallet: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: wallet,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
